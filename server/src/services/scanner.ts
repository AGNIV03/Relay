import { promises as fs } from "node:fs";
import path from "node:path";
import { parseFile } from "music-metadata";
import { prisma } from "../lib/prisma.js";
import { env } from "../lib/env.js";
import { fetchLyrics, lrcToPlain } from "./lyrics.service.js";
import { translateText } from "./translate.service.js";
import { fetchMusixmatchTranslated } from "./musixmatch.service.js";
import { IngestRejectedError, sha256File, verifyDecodes } from "./audioCheck.js";
import { backfillAutotag, queueAutotag } from "./autotag.js";
import { backfillLoudness, queueLoudness } from "./loudness.js";
import { recordRejection } from "./ingestLog.js";

export { IngestRejectedError } from "./audioCheck.js";

const AUDIO_EXT = new Set([".mp3", ".flac", ".m4a", ".aac", ".ogg", ".opus", ".wav", ".wma"]);

export interface ScanResult {
  scanned: number;
  added: number;
  updated: number;
  removed: number;
  errors: number;
  rejected: number; // broken/undecodable files skipped (left on disk)
  duplicates: number; // byte-identical copies of an existing track, skipped
}

// Files a scan already found broken or duplicate, keyed by path → "size:mtime",
// so later scans don't re-hash / re-decode them until they change on disk.
const scanSkip = new Map<string, string>();

let scanning = false;
let lastResult: ScanResult | null = null;

export function getScanStatus() {
  return { scanning, lastResult };
}

async function* walk(dir: string): AsyncGenerator<string> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable dir — skip
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (AUDIO_EXT.has(path.extname(entry.name).toLowerCase())) {
      yield full;
    }
  }
}

export async function findOrCreateArtist(name: string): Promise<string> {
  const clean = name.trim() || "Unknown Artist";
  const existing = await prisma.artist.findUnique({ where: { name: clean } });
  if (existing) return existing.id;
  const created = await prisma.artist.create({ data: { name: clean } });
  return created.id;
}

export async function findOrCreateAlbum(
  title: string,
  artistId: string,
  year: number | undefined,
): Promise<string> {
  const clean = title.trim() || "Unknown Album";
  const existing = await prisma.album.findUnique({
    where: { title_artistId: { title: clean, artistId } },
  });
  if (existing) return existing.id;
  const created = await prisma.album.create({ data: { title: clean, artistId, year } });
  return created.id;
}

/** Save embedded cover art to DATA_PATH/covers/<albumId>.<ext>, return relative path. */
async function saveCover(albumId: string, picture: { format: string; data: Uint8Array }) {
  const ext = picture.format.includes("png") ? "png" : "jpg";
  const dir = path.join(env.dataPath, "covers");
  await fs.mkdir(dir, { recursive: true });
  const rel = path.join("covers", `${albumId}.${ext}`);
  await fs.writeFile(path.join(env.dataPath, rel), Buffer.from(picture.data));
  return rel;
}

/** Delete a cover-art file given its DATA_PATH-relative path (as stored in
 *  Album.coverPath). Refuses anything resolving outside DATA_PATH/covers. */
export async function removeCoverFile(rel: string | null | undefined): Promise<void> {
  if (!rel) return;
  const coversDir = path.resolve(env.dataPath, "covers");
  const abs = path.resolve(env.dataPath, rel);
  if (!abs.startsWith(coversDir + path.sep)) return;
  await fs.rm(abs, { force: true }).catch((e) => {
    console.warn(`[covers] could not remove ${rel}:`, (e as Error).message);
  });
}

/** Delete an album (and its cover file) if no tracks reference it any more. */
export async function deleteAlbumIfEmpty(albumId: string): Promise<void> {
  const left = await prisma.track.count({ where: { albumId } });
  if (left > 0) return;
  const album = await prisma.album.findUnique({ where: { id: albumId }, select: { coverPath: true } });
  if (!album) return;
  await prisma.album.delete({ where: { id: albumId } }).catch(() => {});
  await removeCoverFile(album.coverPath);
}

/** Look up + persist lyrics for a track. Best-effort; never throws. */
export async function fetchAndStoreLyrics(trackId: string): Promise<void> {
  const t = await prisma.track.findUnique({
    where: { id: trackId },
    include: { artist: true, album: true },
  });
  if (!t) return;

  let plain = t.lyricsPlain;
  let synced = t.lyricsSynced;
  let checked = t.lyricsChecked;

  // 1. Fetch the lyrics themselves (once).
  if (!checked) {
    const r = await fetchLyrics(t.artist?.name ?? "", t.title, t.album?.title, t.duration);
    plain = r.plain;
    synced = r.synced;
    checked = r.checked;
    await prisma.track.update({
      where: { id: trackId },
      data: { lyricsPlain: plain, lyricsSynced: synced, lyricsChecked: checked },
    });
  }

  // 2. Translate them to English (once), stored so it's instant later.
  if (checked) await translateAndStore(trackId);
}

/**
 * Produce + persist the English translation for a track (once). Tries Musixmatch's
 * human/crowd translation first — it comes matched line-by-line to a synced (LRC)
 * subtitle, so when found we adopt THAT subtitle as the lyrics and store the
 * translation aligned to it (this is the "matched pair" that keeps the karaoke
 * sync + line-by-line view intact). If Musixmatch has no translation for the song,
 * we fall back to machine-translating the existing lyrics (Google), exactly as
 * before. Best-effort; on a transient failure we leave it unchecked to retry.
 */
export async function translateAndStore(trackId: string): Promise<void> {
  const t = await prisma.track.findUnique({
    where: { id: trackId },
    include: { artist: true },
  });
  if (!t || t.lyricsTransChecked || !t.lyricsChecked) return;

  // 1. Musixmatch matched pair (human translation, perfectly line-aligned).
  if (t.artist?.name && t.title) {
    const mxm = await fetchMusixmatchTranslated(t.artist.name, t.title).catch(() => null);
    if (mxm && mxm.translatedText.trim()) {
      await prisma.track.update({
        where: { id: trackId },
        data: {
          lyricsSynced: mxm.syncedLrc,
          lyricsPlain: lrcToPlain(mxm.syncedLrc),
          lyricsTranslated: mxm.translatedText,
          lyricsLang: mxm.lang ?? t.lyricsLang,
          lyricsTransChecked: true,
        },
      });
      return;
    }
  }

  // 2. Fallback: Google MT of whatever lyrics we already have (source taken from
  //    the synced lyrics so it aligns line-by-line; else the plain text).
  const src = t.lyricsSynced ? lrcToPlain(t.lyricsSynced) : (t.lyricsPlain?.trim() ?? "");
  if (!src) {
    await prisma.track.update({ where: { id: trackId }, data: { lyricsTransChecked: true } });
    return;
  }
  try {
    const r = await translateText(src, "en");
    const english = r.lang === "en" || !r.text;
    await prisma.track.update({
      where: { id: trackId },
      data: {
        lyricsLang: r.lang,
        lyricsTranslated: english ? null : r.text,
        lyricsTransChecked: true,
      },
    });
  } catch {
    /* transient — leave unchecked so it retries on the next request */
  }
}

/**
 * Parse a single audio file and upsert it (artist/album/cover/track). Returns
 * the track id and whether it was newly created. Shared by full scans and uploads.
 *
 * `duplicate: true` means the file is byte-identical to an existing track (any
 * path), or — with `dedupe` — has the same title + artist + album; nothing is
 * written and the caller decides what to do with the file. Throws
 * IngestRejectedError when the file has no playable audio.
 */
export async function ingestFile(
  file: string,
  uploaderId?: string,
  dedupe = false,
): Promise<{ trackId: string; created: boolean; duplicate?: boolean } | null> {
  const stat = await fs.stat(file);
  const existing = await prisma.track.findUnique({ where: { path: file } });
  if (existing && existing.size === stat.size) {
    return { trackId: existing.id, created: false }; // unchanged
  }

  // Exact-duplicate check by content, independent of tags.
  const contentHash = await sha256File(file);
  const sameBytes = await prisma.track.findFirst({
    where: { contentHash, ...(existing ? { id: { not: existing.id } } : {}) },
    select: { id: true, path: true },
  });
  if (sameBytes) {
    if (!existing && !(await fileExists(sameBytes.path))) {
      // The other copy's file is gone: this is the same song moved/renamed.
      // Re-point that row so its likes / playlists / history survive the move.
      await prisma.track.update({ where: { id: sameBytes.id }, data: { path: file, size: stat.size } });
      return { trackId: sameBytes.id, created: false };
    }
    return { trackId: sameBytes.id, created: false, duplicate: true };
  }

  const meta = await parseFile(file, { duration: true });
  const common = meta.common;
  const fmt = meta.format;

  const artistName = (common.artist || common.albumartist || "").trim() || "Unknown Artist";
  const title = common.title || path.basename(file, path.extname(file));
  const albumTitle = (common.album || "Unknown Album").trim() || "Unknown Album";
  // Reject duplicate songs (same title + album + artist already in the library).
  // Checked before creating any artist/album row so we don't leave orphans behind.
  if (dedupe && !existing) {
    const artist = await prisma.artist.findUnique({ where: { name: artistName } });
    const dup = artist
      ? await prisma.track.findFirst({
          where: {
            title: { equals: title, mode: "insensitive" },
            artistId: artist.id,
            album: { is: { title: { equals: albumTitle, mode: "insensitive" } } },
          },
        })
      : null;
    if (dup) return { trackId: dup.id, created: false, duplicate: true };
  }

  // Make sure the audio actually decodes (headers can lie — e.g. a FLAC that is
  // only embedded art). Throws IngestRejectedError; nothing has been written yet.
  await verifyDecodes(file, fmt.duration ?? 0);

  const artistId = await findOrCreateArtist(artistName);
  const albumId = await findOrCreateAlbum(albumTitle, artistId, common.year);

  const album = await prisma.album.findUnique({ where: { id: albumId } });
  if (album && !album.coverPath && common.picture?.[0]) {
    const rel = await saveCover(albumId, common.picture[0]);
    await prisma.album.update({ where: { id: albumId }, data: { coverPath: rel } });
  }

  const data = {
    title,
    duration: fmt.duration ?? 0,
    trackNo: common.track?.no ?? null,
    discNo: common.disk?.no ?? null,
    genre: common.genre?.[0] ?? null,
    format: path.extname(file).slice(1).toLowerCase(),
    bitrate: fmt.bitrate ? Math.round(fmt.bitrate / 1000) : null,
    size: stat.size,
    contentHash,
    albumId,
    artistId,
  };

  if (existing) {
    // The file changed on disk: re-measure its loudness (scan backfill).
    await prisma.track.update({ where: { id: existing.id }, data: { ...data, loudnessLufs: null } });
    return { trackId: existing.id, created: false };
  }
  const created = await prisma.track.create({
    data: { ...data, path: file, uploaderId: uploaderId ?? null },
  });
  return { trackId: created.id, created: true };
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function processFile(file: string, result: ScanResult) {
  // Known-bad / known-duplicate file that hasn't changed since: skip cheaply.
  const st = await fs.stat(file);
  const sig = `${st.size}:${st.mtimeMs}`;
  if (scanSkip.get(file) === sig) return;
  scanSkip.delete(file);

  let r: Awaited<ReturnType<typeof ingestFile>>;
  try {
    r = await ingestFile(file);
  } catch (err) {
    if (!(err instanceof IngestRejectedError)) throw err;
    // Broken audio: skip it, but leave the file alone — the library folder
    // belongs to the operator.
    result.rejected++;
    scanSkip.set(file, sig);
    console.warn(`[scan] skipped ${file}: ${err.reason}`);
    recordRejection(path.relative(env.musicPath, file) || path.basename(file), err.reason, "scan");
    return;
  }
  if (!r) return;
  result.scanned++;
  if (r.duplicate) {
    result.duplicates++;
    scanSkip.set(file, sig);
    console.log(`[scan] skipped ${file}: identical to existing track ${r.trackId}`);
    return;
  }
  if (r.created) {
    result.added++;
    // Fetch lyrics for new tracks (best-effort, don't block on failure).
    await fetchAndStoreLyrics(r.trackId).catch(() => {});
    queueAutotag(r.trackId); // background; no-op unless enabled
    queueLoudness(r.trackId); // background
  } else {
    result.updated++;
  }
}

/** Fill contentHash for tracks ingested before hashing existed. */
async function backfillHashes(limit: number) {
  const rows = await prisma.track.findMany({
    where: { contentHash: null },
    select: { id: true, path: true },
    take: limit,
  });
  for (const t of rows) {
    try {
      const contentHash = await sha256File(t.path);
      await prisma.track.update({ where: { id: t.id }, data: { contentHash } });
    } catch (e) {
      console.warn(`[scan] could not hash ${t.path}:`, (e as Error).message);
    }
  }
}

/** Remove DB tracks whose files no longer exist on disk. */
async function pruneMissing(result: ScanResult) {
  const tracks = await prisma.track.findMany({ select: { id: true, path: true } });
  for (const t of tracks) {
    try {
      await fs.access(t.path);
    } catch {
      await prisma.track.delete({ where: { id: t.id } });
      result.removed++;
    }
  }
  const emptyAlbums = await prisma.album.findMany({
    where: { tracks: { none: {} } },
    select: { id: true, coverPath: true },
  });
  await prisma.album.deleteMany({ where: { id: { in: emptyAlbums.map((a) => a.id) } } });
  for (const a of emptyAlbums) await removeCoverFile(a.coverPath);
  await prisma.artist.deleteMany({ where: { tracks: { none: {} }, albums: { none: {} } } });
}

export async function runScan(): Promise<ScanResult> {
  if (scanning) throw new Error("A scan is already in progress");
  scanning = true;
  const result: ScanResult = {
    scanned: 0,
    added: 0,
    updated: 0,
    removed: 0,
    errors: 0,
    rejected: 0,
    duplicates: 0,
  };
  try {
    for await (const file of walk(env.musicPath)) {
      try {
        await processFile(file, result);
      } catch (err) {
        result.errors++;
        console.error(`[scan] failed on ${file}:`, (err as Error).message);
      }
    }
    await pruneMissing(result);
    // Backfill lyrics for any tracks not yet checked (e.g. earlier failures).
    const pending = await prisma.track.findMany({
      where: { lyricsChecked: false },
      select: { id: true },
      take: 200,
    });
    for (const t of pending) await fetchAndStoreLyrics(t.id).catch(() => {});
    // Backfill content hashes (dedup) and, when enabled, AcoustID auto-tags.
    await backfillHashes(200).catch((e) => console.warn("[scan] hash backfill failed:", e.message));
    await backfillAutotag(50);
    await backfillLoudness(200); // queues only; measurements run in the background
    lastResult = result;
    console.log("[scan] complete:", result);
    return result;
  } finally {
    scanning = false;
  }
}
