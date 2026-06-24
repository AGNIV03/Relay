import { promises as fs } from "node:fs";
import path from "node:path";
import { parseFile } from "music-metadata";
import { prisma } from "../lib/prisma.js";
import { env } from "../lib/env.js";
import { fetchLyrics, lrcToPlain } from "./lyrics.service.js";
import { translateText } from "./translate.service.js";
import { fetchMusixmatchTranslated } from "./musixmatch.service.js";

const AUDIO_EXT = new Set([".mp3", ".flac", ".m4a", ".aac", ".ogg", ".opus", ".wav", ".wma"]);

export interface ScanResult {
  scanned: number;
  added: number;
  updated: number;
  removed: number;
  errors: number;
}

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

async function findOrCreateArtist(name: string): Promise<string> {
  const clean = name.trim() || "Unknown Artist";
  const existing = await prisma.artist.findUnique({ where: { name: clean } });
  if (existing) return existing.id;
  const created = await prisma.artist.create({ data: { name: clean } });
  return created.id;
}

async function findOrCreateAlbum(
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

  const meta = await parseFile(file, { duration: true });
  const common = meta.common;
  const fmt = meta.format;

  const artistName = common.artist || common.albumartist || "Unknown Artist";
  const artistId = await findOrCreateArtist(artistName);

  const title = common.title || path.basename(file, path.extname(file));
  const albumTitle = (common.album || "Unknown Album").trim() || "Unknown Album";
  // Reject duplicate songs (same title + album + artist already in the library).
  // Checked before creating the album so we don't leave an orphan album behind.
  if (dedupe && !existing) {
    const dup = await prisma.track.findFirst({
      where: {
        title: { equals: title, mode: "insensitive" },
        artistId,
        album: { is: { title: { equals: albumTitle, mode: "insensitive" } } },
      },
    });
    if (dup) return { trackId: dup.id, created: false, duplicate: true };
  }

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
    albumId,
    artistId,
  };

  if (existing) {
    await prisma.track.update({ where: { id: existing.id }, data });
    return { trackId: existing.id, created: false };
  }
  const created = await prisma.track.create({
    data: { ...data, path: file, uploaderId: uploaderId ?? null },
  });
  return { trackId: created.id, created: true };
}

async function processFile(file: string, result: ScanResult) {
  const r = await ingestFile(file);
  if (!r) return;
  result.scanned++;
  if (r.created) {
    result.added++;
    // Fetch lyrics for new tracks (best-effort, don't block on failure).
    await fetchAndStoreLyrics(r.trackId).catch(() => {});
  } else {
    result.updated++;
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
  await prisma.album.deleteMany({ where: { tracks: { none: {} } } });
  await prisma.artist.deleteMany({ where: { tracks: { none: {} }, albums: { none: {} } } });
}

export async function runScan(): Promise<ScanResult> {
  if (scanning) throw new Error("A scan is already in progress");
  scanning = true;
  const result: ScanResult = { scanned: 0, added: 0, updated: 0, removed: 0, errors: 0 };
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
    lastResult = result;
    console.log("[scan] complete:", result);
    return result;
  } finally {
    scanning = false;
  }
}
