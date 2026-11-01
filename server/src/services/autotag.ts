// Opt-in auto-tagging via AcoustID (audio fingerprint → MusicBrainz recording).
//
// Active only when ACOUSTID_API_KEY is set AND the Chromaprint `fpcalc` binary is
// on PATH. Runs in the background after ingest — never on the request path — and
// is deliberately conservative: it always records the AcoustID/MusicBrainz ids,
// but only REPLACES a title/artist/album that is missing or a placeholder. Real
// tags are never touched, and the audio file itself is never modified.
//
// acoustId === "" marks "looked up, no confident match" so backfills don't retry
// the same unidentifiable track every scan. Transient failures leave it null.
import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { prisma } from "../lib/prisma.js";
import { env } from "../lib/env.js";
import { fetchAndStoreLyrics, findOrCreateAlbum, findOrCreateArtist } from "./scanner.js";

const LOOKUP_URL = "https://api.acoustid.org/v2/lookup";
const MIN_SCORE = 0.85;
const LOOKUP_TIMEOUT_MS = 15_000;
const FPCALC_TIMEOUT_MS = 60_000;
const MIN_REQUEST_GAP_MS = 340; // AcoustID allows max 3 requests/second
const MAX_CONCURRENT = 2; // fingerprinting jobs at once (fpcalc is CPU-bound)
const MAX_PENDING = 1000; // beyond this, drop — the scan backfill picks them up later

// ---- Availability (checked once) -------------------------------------------

let fpcalcCheck: Promise<boolean> | null = null;

function probeFpcalc(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const p = spawn("fpcalc", ["-version"], { stdio: "ignore", windowsHide: true });
      p.on("error", () => resolve(false));
      p.on("close", (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

/** True when auto-tagging can run (key configured + fpcalc installed). Cached. */
export async function autotagEnabled(): Promise<boolean> {
  if (!env.acoustIdKey) return false;
  fpcalcCheck ??= probeFpcalc().then((ok) => {
    if (!ok) console.warn("[autotag] ACOUSTID_API_KEY is set but `fpcalc` was not found — auto-tagging disabled");
    else console.log("[autotag] enabled (AcoustID + fpcalc)");
    return ok;
  });
  return fpcalcCheck;
}

// ---- Job queue ---------------------------------------------------------------

const inflight = new Map<string, Promise<void>>(); // trackId -> job (queued or running)
const pending: Array<() => void> = [];
let running = 0;
const failedThisRun = new Set<string>(); // transient failures; skipped by backfill until restart

function runNext() {
  while (running < MAX_CONCURRENT && pending.length) {
    running++;
    pending.shift()!();
  }
}

/** Auto-tag a track (resolves when done; never rejects). Deduped per track. */
export function autotagTrack(trackId: string): Promise<void> {
  const existing = inflight.get(trackId);
  if (existing) return existing;
  if (inflight.size >= MAX_PENDING) return Promise.resolve();
  const job = new Promise<void>((resolve) => {
    pending.push(() => {
      tagOne(trackId)
        .catch((e) => {
          failedThisRun.add(trackId);
          console.warn(`[autotag] ${trackId} failed:`, (e as Error).message);
        })
        .finally(() => {
          running--;
          inflight.delete(trackId);
          resolve();
          runNext();
        });
    });
  });
  inflight.set(trackId, job);
  runNext();
  return job;
}

/** Fire-and-forget variant for ingest paths. No-op when auto-tagging is disabled. */
export function queueAutotag(trackId: string): void {
  autotagEnabled()
    .then((on) => (on ? autotagTrack(trackId) : undefined))
    .catch(() => {});
}

/** Scan backfill: tag up to `limit` tracks never looked up. Never throws. */
export async function backfillAutotag(limit = 50): Promise<void> {
  try {
    if (!(await autotagEnabled())) return;
    const rows = await prisma.track.findMany({
      where: { acoustId: null, id: { notIn: [...failedThisRun] } },
      select: { id: true },
      take: limit,
    });
    await Promise.all(rows.map((r) => autotagTrack(r.id)));
  } catch (e) {
    console.warn("[autotag] backfill failed:", (e as Error).message);
  }
}

// ---- Rate limit (global, all lookups) ----------------------------------------

let nextSlot = 0;
async function rateLimit() {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + MIN_REQUEST_GAP_MS;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

// ---- fpcalc + AcoustID -------------------------------------------------------

/** `fpcalc -json <file>` → { duration, fingerprint }, or null if it can't. */
function fingerprint(file: string): Promise<{ duration: number; fingerprint: string } | null> {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (v: { duration: number; fingerprint: string } | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    let p: ReturnType<typeof spawn>;
    try {
      p = spawn("fpcalc", ["-json", file], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    } catch {
      return finish(null);
    }
    const timer = setTimeout(() => {
      p.kill("SIGKILL");
      finish(null);
    }, FPCALC_TIMEOUT_MS);
    p.stdout!.setEncoding("utf8");
    p.stdout!.on("data", (c: string) => {
      if (out.length < 1_000_000) out += c;
    });
    p.on("error", () => finish(null));
    p.on("close", (code) => {
      if (code !== 0) return finish(null);
      try {
        const j = JSON.parse(out) as { duration?: unknown; fingerprint?: unknown };
        const duration = Number(j.duration);
        if (typeof j.fingerprint !== "string" || !j.fingerprint || !(duration > 0)) return finish(null);
        finish({ duration, fingerprint: j.fingerprint });
      } catch {
        finish(null);
      }
    });
  });
}

interface Match {
  acoustId: string;
  recordingId: string;
  title: string | null;
  artist: string | null;
  album: string | null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Ask AcoustID who this is. Returns the best confident match, null for "no
 *  confident match", or throws on a transient (network/HTTP/API) failure. */
async function lookup(fp: { duration: number; fingerprint: string }, trackSeconds: number): Promise<Match | null> {
  await rateLimit();
  const body = new URLSearchParams({
    client: env.acoustIdKey,
    format: "json",
    duration: String(Math.round(fp.duration)),
    fingerprint: fp.fingerprint,
    meta: "recordings releasegroups compress",
  });
  const res = await fetch(LOOKUP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`AcoustID HTTP ${res.status}`);
  const j = (await res.json()) as unknown;
  if (!isObj(j) || j.status !== "ok") {
    const msg = isObj(j) && isObj(j.error) ? str(j.error.message) : null;
    throw new Error(`AcoustID error${msg ? `: ${msg}` : ""}`);
  }

  const results = arr(j.results)
    .filter((r) => typeof r.score === "number" && r.score >= MIN_SCORE && str(r.id))
    .sort((a, b) => (b.score as number) - (a.score as number));

  for (const r of results) {
    const recs = arr(r.recordings).filter((x) => str(x.id));
    if (!recs.length) continue;
    // Prefer a recording with a title whose length is closest to the file's.
    const target = trackSeconds > 0 ? trackSeconds : fp.duration;
    const rec = [...recs].sort((a, b) => {
      const ta = str(a.title) ? 0 : 1;
      const tb = str(b.title) ? 0 : 1;
      if (ta !== tb) return ta - tb;
      const da = typeof a.duration === "number" ? Math.abs(a.duration - target) : 1e9;
      const db = typeof b.duration === "number" ? Math.abs(b.duration - target) : 1e9;
      return da - db;
    })[0];

    const artists = arr(rec.artists);
    let artist: string | null = null;
    if (artists.length) {
      // Honour MusicBrainz join phrases ("A feat. B") when present.
      const hasJoin = artists.some((a) => typeof a.joinphrase === "string");
      artist = hasJoin
        ? artists.map((a) => `${str(a.name) ?? ""}${typeof a.joinphrase === "string" ? a.joinphrase : ""}`).join("").trim()
        : artists.map((a) => str(a.name)).filter(Boolean).join(", ");
      artist = artist || null;
    }

    // Album: prefer a plain studio "Album" release group over singles/compilations.
    const groups = arr(rec.releasegroups).filter((g) => str(g.title));
    const plain = (g: Obj) =>
      g.type === "Album" && !(Array.isArray(g.secondarytypes) && g.secondarytypes.length);
    const group = groups.find(plain) ?? groups.find((g) => g.type === "Album") ?? groups[0];

    return {
      acoustId: str(r.id)!,
      recordingId: str(rec.id)!,
      title: str(rec.title),
      artist,
      album: group ? str(group.title) : null,
    };
  }
  return null;
}

// ---- Apply ---------------------------------------------------------------------

const PLACEHOLDER_ARTIST = "unknown artist";
const PLACEHOLDER_ALBUM = "unknown album";

async function tagOne(trackId: string): Promise<void> {
  const t = await prisma.track.findUnique({
    where: { id: trackId },
    include: { artist: true, album: true },
  });
  if (!t || t.acoustId !== null) return; // gone, or already looked up

  try {
    await fs.access(t.path);
  } catch {
    return; // file missing — the scan will prune it
  }

  const fp = await fingerprint(t.path);
  if (!fp) {
    // fpcalc can't read it at all — mark looked-up so we don't retry forever.
    await prisma.track.update({ where: { id: trackId }, data: { acoustId: "" } });
    return;
  }
  const m = await lookup(fp, t.duration); // throws on transient failure (stays null)
  if (!m) {
    await prisma.track.update({ where: { id: trackId }, data: { acoustId: "" } });
    return;
  }

  const fileStem = path.basename(t.path, path.extname(t.path)).trim().toLowerCase();
  const curTitle = t.title?.trim() ?? "";
  const curArtist = t.artist?.name?.trim() ?? "";
  const curAlbum = t.album?.title?.trim() ?? "";
  const titlePlaceholder = !curTitle || curTitle.toLowerCase() === fileStem;
  const artistPlaceholder = !curArtist || curArtist.toLowerCase() === PLACEHOLDER_ARTIST;
  const albumPlaceholder = !curAlbum || curAlbum.toLowerCase() === PLACEHOLDER_ALBUM;

  const newTitle = titlePlaceholder && m.title ? m.title : t.title;
  const artistId = artistPlaceholder && m.artist ? await findOrCreateArtist(m.artist) : t.artistId;
  let albumId = t.albumId;
  if (albumPlaceholder && m.album) {
    albumId = await findOrCreateAlbum(m.album, artistId, t.album?.year ?? undefined);
  } else if (artistId !== t.artistId && t.album) {
    // Real album title but the artist moved: re-home it under the new artist,
    // the same (title, artist) keying ingest uses.
    albumId = await findOrCreateAlbum(t.album.title, artistId, t.album.year ?? undefined);
  }
  if (albumId && albumId !== t.albumId && t.album?.coverPath) await inheritCover(albumId, t.album.coverPath);

  const retagged = newTitle !== t.title || artistId !== t.artistId;
  await prisma.track.update({
    where: { id: trackId },
    data: {
      acoustId: m.acoustId,
      mbRecordingId: m.recordingId,
      title: newTitle,
      artistId,
      albumId,
      // Lyrics were looked up under the placeholder tags — redo them.
      ...(retagged
        ? {
            lyricsChecked: false,
            lyricsTransChecked: false,
            lyricsPlain: null,
            lyricsSynced: null,
            lyricsTranslated: null,
            lyricsLang: null,
          }
        : {}),
    },
  });

  if (retagged || albumId !== t.albumId) {
    console.log(
      `[autotag] ${t.path}: "${curTitle}" / "${curArtist}" / "${curAlbum}" → ` +
        `"${newTitle}" / "${m.artist && artistPlaceholder ? m.artist : curArtist}" / "${m.album && albumPlaceholder ? m.album : curAlbum}"`,
    );
  }

  // Tidy up rows the re-link may have emptied.
  if (t.albumId && albumId !== t.albumId) {
    const left = await prisma.track.count({ where: { albumId: t.albumId } });
    if (left === 0) await prisma.album.delete({ where: { id: t.albumId } }).catch(() => {});
  }
  if (artistId !== t.artistId) {
    const [tracksLeft, albumsLeft] = await Promise.all([
      prisma.track.count({ where: { artistId: t.artistId } }),
      prisma.album.count({ where: { artistId: t.artistId } }),
    ]);
    if (tracksLeft === 0 && albumsLeft === 0) {
      await prisma.artist.delete({ where: { id: t.artistId } }).catch(() => {});
    }
  }

  if (retagged) await fetchAndStoreLyrics(trackId).catch(() => {});
}

/** Give a newly-linked album the old album's cover if it has none (copied, since
 *  cover files are named per album). Best-effort. */
async function inheritCover(albumId: string, oldRel: string) {
  try {
    const album = await prisma.album.findUnique({ where: { id: albumId } });
    if (!album || album.coverPath) return;
    const rel = path.join("covers", `${albumId}${path.extname(oldRel) || ".jpg"}`);
    await fs.copyFile(path.join(env.dataPath, oldRel), path.join(env.dataPath, rel));
    await prisma.album.update({ where: { id: albumId }, data: { coverPath: rel } });
  } catch {
    /* no cover is fine */
  }
}
