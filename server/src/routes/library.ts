import express, { Router } from "express";
import { z } from "zod";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { fetchAndStoreLyrics, ingestFile } from "../services/scanner.js";
import { translateText } from "../services/translate.service.js";
import { env } from "../lib/env.js";

/** Strip LRC timestamp/metadata tags to plain lines for translation. */
function lrcToPlain(lrc: string): string {
  return lrc
    .split("\n")
    .map((l) => l.replace(/\[[^\]]*\]/g, "").trim())
    .filter((l) => l.length > 0)
    .join("\n");
}

const router = Router();
router.use(requireAuth);

// Uploads are restricted to MP3 + FLAC only.
const UPLOAD_EXT = new Set([".mp3", ".flac"]);

/**
 * Sniff the first bytes to confirm the file is genuinely an MP3 or FLAC — not a
 * renamed executable/script. FLAC starts with "fLaC"; MP3 starts with an "ID3"
 * tag or an MPEG audio frame sync (0xFF Ex/Fx).
 */
function looksLikeAudio(filePath: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    if (buf.toString("latin1") === "fLaC") return true; // FLAC
    if (buf.toString("latin1", 0, 3) === "ID3") return true; // MP3 with ID3v2
    if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return true; // MPEG frame sync
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Uploads are written verbatim to the music library — NO transcoding, so original
// quality (incl. lossless) is preserved byte-for-byte. Any signed-in user may
// upload; the track becomes visible to everyone (this is a sharing app).
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const dir = path.join(env.musicPath, "uploads");
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const base = path.basename(file.originalname).replace(/[\\/:*?"<>|]/g, "_");
    let name = base;
    let i = 1;
    while (fs.existsSync(path.join(env.musicPath, "uploads", name))) {
      const ext = path.extname(base);
      name = `${path.basename(base, ext)} (${i++})${ext}`;
    }
    cb(null, name);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
  fileFilter: (_req, file, cb) =>
    cb(null, UPLOAD_EXT.has(path.extname(file.originalname).toLowerCase())),
});

/** GET /api/library/artists */
router.get("/artists", async (_req, res) => {
  const artists = await prisma.artist.findMany({
    orderBy: { name: "asc" },
    include: { _count: { select: { albums: true, tracks: true } } },
  });
  res.json(artists);
});

/** GET /api/library/artists/:id */
router.get("/artists/:id", async (req, res) => {
  const artist = await prisma.artist.findUnique({
    where: { id: req.params.id },
    include: {
      albums: { orderBy: { year: "asc" }, include: { _count: { select: { tracks: true } } } },
    },
  });
  if (!artist) return res.status(404).json({ error: "Not found" });
  res.json(artist);
});

/** GET /api/library/albums?recent=1 */
router.get("/albums", async (req, res) => {
  const recent = req.query.recent === "1";
  const albums = await prisma.album.findMany({
    orderBy: recent ? { createdAt: "desc" } : { title: "asc" },
    take: recent ? 50 : undefined,
    include: { artist: true, _count: { select: { tracks: true } } },
  });
  res.json(albums);
});

/** GET /api/library/albums/:id */
router.get("/albums/:id", async (req, res) => {
  const album = await prisma.album.findUnique({
    where: { id: req.params.id },
    include: {
      artist: true,
      tracks: {
        orderBy: [{ discNo: "asc" }, { trackNo: "asc" }, { title: "asc" }],
        include: { artist: true },
      },
    },
  });
  if (!album) return res.status(404).json({ error: "Not found" });
  res.json(album);
});

/** GET /api/library/tracks?limit=&offset=&q= — flat list, optional search across title/artist/album */
router.get("/tracks", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 1000);
  const offset = Number(req.query.offset) || 0;
  const q = (req.query.q as string | undefined)?.trim();
  const contains = q ? { contains: q, mode: "insensitive" as const } : undefined;
  const where = contains
    ? {
        OR: [
          { title: contains },
          { artist: { name: contains } },
          { album: { title: contains } },
        ],
      }
    : {};
  const [tracks, total] = await Promise.all([
    prisma.track.findMany({
      where,
      orderBy: { title: "asc" },
      skip: offset,
      take: limit,
      include: { artist: true, album: true, uploader: { select: { username: true } } },
    }),
    prisma.track.count({ where }),
  ]);
  res.json({ tracks, total, limit, offset });
});

/** GET /api/library/tracks/by-ids?ids=a,b,c — hydrate specific tracks, preserving
 *  the requested order. Used by a Chorus host to resolve member-proposed queues. */
router.get("/tracks/by-ids", async (req, res) => {
  const ids = String(req.query.ids ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 1000);
  if (ids.length === 0) return res.json({ tracks: [] });
  const found = await prisma.track.findMany({
    where: { id: { in: ids } },
    include: { artist: true, album: true, uploader: { select: { username: true } } },
  });
  const byId = new Map(found.map((t) => [t.id, t]));
  const tracks = ids.map((id) => byId.get(id)).filter(Boolean);
  res.json({ tracks });
});

/** POST /api/library/scrobble { trackId } — record a play (drives stats + recently/most played) */
router.post("/scrobble", async (req, res) => {
  const parsed = z.object({ trackId: z.string() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });
  await prisma.playHistory.create({ data: { userId: req.user!.id, trackId: parsed.data.trackId } });
  res.status(204).end();
});

/** GET /api/library/recently-played — distinct tracks, most recent first */
router.get("/recently-played", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 12, 50);
  const groups = await prisma.playHistory.groupBy({
    by: ["trackId"],
    where: { userId: req.user!.id },
    _max: { playedAt: true },
    orderBy: { _max: { playedAt: "desc" } },
    take: limit,
  });
  const tracks = await prisma.track.findMany({
    where: { id: { in: groups.map((g) => g.trackId) } },
    include: { artist: true, album: true },
  });
  const byId = new Map(tracks.map((t) => [t.id, t]));
  res.json(groups.map((g) => byId.get(g.trackId)).filter(Boolean));
});

/** GET /api/library/most-played — top tracks by play count */
router.get("/most-played", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 12, 50);
  const groups = await prisma.playHistory.groupBy({
    by: ["trackId"],
    where: { userId: req.user!.id },
    _count: { trackId: true },
    orderBy: { _count: { trackId: "desc" } },
    take: limit,
  });
  const tracks = await prisma.track.findMany({
    where: { id: { in: groups.map((g) => g.trackId) } },
    include: { artist: true, album: true },
  });
  const byId = new Map(tracks.map((t) => [t.id, t]));
  res.json(
    groups
      .map((g) => {
        const t = byId.get(g.trackId);
        return t ? { ...t, playCount: g._count.trackId } : null;
      })
      .filter(Boolean),
  );
});

/** GET /api/library/stats/me — personal "wrapped"-style listening summary */
router.get("/stats/me", async (req, res) => {
  const userId = req.user!.id;
  const grouped = await prisma.playHistory.groupBy({
    by: ["trackId"],
    where: { userId },
    _count: { trackId: true },
  });
  const tracks = await prisma.track.findMany({
    where: { id: { in: grouped.map((g) => g.trackId) } },
    include: { artist: true },
  });
  const byId = new Map(tracks.map((t) => [t.id, t]));

  let totalPlays = 0;
  let totalSeconds = 0;
  const artistCounts = new Map<string, number>();
  const genreCounts = new Map<string, number>();
  for (const g of grouped) {
    const t = byId.get(g.trackId);
    if (!t) continue;
    const c = g._count.trackId;
    totalPlays += c;
    totalSeconds += c * (t.duration || 0);
    const an = t.artist?.name;
    if (an) artistCounts.set(an, (artistCounts.get(an) ?? 0) + c);
    if (t.genre) genreCounts.set(t.genre, (genreCounts.get(t.genre) ?? 0) + c);
  }
  const top = (m: Map<string, number>, n: number) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, count]) => ({ name, count }));

  const topTracks = grouped
    .map((g) => ({ t: byId.get(g.trackId), c: g._count.trackId }))
    .filter((x) => x.t)
    .sort((a, b) => b.c - a.c)
    .slice(0, 5)
    .map((x) => ({ id: x.t!.id, title: x.t!.title, artist: x.t!.artist?.name ?? "", playCount: x.c }));

  res.json({
    totalPlays,
    totalMinutes: Math.round(totalSeconds / 60),
    distinctTracks: grouped.length,
    topArtists: top(artistCounts, 5),
    topGenres: top(genreCounts, 5),
    topTracks,
  });
});

/** GET /api/library/tracks/:id/lyrics — synced (LRC) + plain + line-aligned English
 *  translation; fetches/translates on demand if not yet done. */
router.get("/tracks/:id/lyrics", async (req, res) => {
  let track = await prisma.track.findUnique({ where: { id: req.params.id } });
  if (!track) return res.status(404).json({ error: "Not found" });
  if (!track.lyricsChecked || !track.lyricsTransChecked) {
    await fetchAndStoreLyrics(track.id).catch(() => {});
    track = await prisma.track.findUnique({ where: { id: req.params.id } });
  }
  res.json({
    synced: track?.lyricsSynced ?? null,
    plain: track?.lyricsPlain ?? null,
    translated: track?.lyricsTranslated ?? null,
    lang: track?.lyricsLang ?? null,
  });
});

/** GET /api/library/tracks/:id/lyrics/translation — English MT of the lyrics */
router.get("/tracks/:id/lyrics/translation", async (req, res) => {
  let track = await prisma.track.findUnique({ where: { id: req.params.id } });
  if (!track) return res.status(404).json({ error: "Not found" });
  // Make sure lyrics have been fetched first (translation needs a source).
  if (!track.lyricsChecked) {
    await fetchAndStoreLyrics(track.id).catch(() => {});
    track = await prisma.track.findUnique({ where: { id: req.params.id } });
  }
  if (track && !track.lyricsTransChecked) {
    const src =
      track.lyricsPlain?.trim() || (track.lyricsSynced ? lrcToPlain(track.lyricsSynced) : "");
    if (!src) {
      await prisma.track.update({ where: { id: track.id }, data: { lyricsTransChecked: true } });
    } else {
      try {
        const r = await translateText(src, "en");
        const english = r.lang === "en" || !r.text;
        await prisma.track.update({
          where: { id: track.id },
          data: {
            lyricsLang: r.lang,
            lyricsTranslated: english ? null : r.text,
            lyricsTransChecked: true,
          },
        });
      } catch {
        /* leave unchecked so it retries on the next request */
      }
    }
    track = await prisma.track.findUnique({ where: { id: req.params.id } });
  }
  res.json({ lang: track?.lyricsLang ?? null, translated: track?.lyricsTranslated ?? null });
});

/** DELETE /api/library/tracks/:id — permanently delete a track: removes the DB
 *  record (cascades likes / playlist entries / play history) AND the underlying
 *  audio file from storage. Allowed for an ADMIN or the user who uploaded it. */
router.delete("/tracks/:id", async (req, res) => {
  const track = await prisma.track.findUnique({ where: { id: req.params.id } });
  if (!track) return res.status(404).json({ error: "Not found" });
  const isAdmin = req.user!.role === "ADMIN";
  if (!isAdmin && track.uploaderId !== req.user!.id) {
    return res.status(403).json({ error: "You can only delete songs you uploaded" });
  }

  const { albumId, artistId, path: filePath } = track;

  // Remove the DB row first (FK cascades clear favorites/playlist entries/history).
  await prisma.track.delete({ where: { id: track.id } });

  // Delete the actual file from disk so storage is reclaimed.
  try {
    if (filePath) fs.rmSync(filePath, { force: true });
  } catch (e) {
    console.error(`[delete] could not remove file ${filePath}:`, (e as Error).message);
  }

  // Clean up an album left with no tracks (plus its cover-art file).
  if (albumId) {
    const remaining = await prisma.track.count({ where: { albumId } });
    if (remaining === 0) {
      const album = await prisma.album.findUnique({ where: { id: albumId } });
      if (album?.coverPath) {
        try {
          fs.rmSync(album.coverPath, { force: true });
        } catch {
          /* ignore */
        }
      }
      await prisma.album.delete({ where: { id: albumId } }).catch(() => {});
    }
  }
  // Clean up an artist left with no tracks and no albums.
  const tracksLeft = await prisma.track.count({ where: { artistId } });
  const albumsLeft = await prisma.album.count({ where: { artistId } });
  if (tracksLeft === 0 && albumsLeft === 0) {
    await prisma.artist.delete({ where: { id: artistId } }).catch(() => {});
  }

  res.status(204).end();
});

// ---- Likes / "Liked Songs" ------------------------------------------------

/** GET /api/library/liked — the user's liked tracks (newest first), playlist-shaped */
router.get("/liked", async (req, res) => {
  const favs = await prisma.favorite.findMany({
    where: { userId: req.user!.id },
    orderBy: { createdAt: "desc" },
    include: { track: { include: { artist: true, album: true } } },
  });
  res.json({
    id: "liked",
    name: "Liked Songs",
    system: true,
    tracks: favs.map((f, i) => ({ id: f.id, position: i, addedAt: f.createdAt, track: f.track })),
  });
});

/** GET /api/library/liked/ids — set of liked track ids, for cheap client-side state */
router.get("/liked/ids", async (req, res) => {
  const favs = await prisma.favorite.findMany({
    where: { userId: req.user!.id },
    select: { trackId: true },
  });
  res.json(favs.map((f) => f.trackId));
});

/** POST /api/library/like { trackId } — like a track (idempotent) */
router.post("/like", async (req, res) => {
  const parsed = z.object({ trackId: z.string() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });
  await prisma.favorite
    .upsert({
      where: { userId_trackId: { userId: req.user!.id, trackId: parsed.data.trackId } },
      create: { userId: req.user!.id, trackId: parsed.data.trackId },
      update: {},
    })
    .catch(() => {});
  res.status(204).end();
});

/** DELETE /api/library/like/:trackId — unlike a track */
router.delete("/like/:trackId", async (req, res) => {
  await prisma.favorite.deleteMany({
    where: { userId: req.user!.id, trackId: req.params.trackId },
  });
  res.status(204).end();
});

// ---- Uploads (any signed-in user) -----------------------------------------

type UploadStatus = "added" | "duplicate" | "failed";

/** Validate + ingest one already-saved upload file; auto-likes it for the
 *  uploader. Deletes the file on rejection or duplicate. Shared by the multipart
 *  and chunked upload paths. */
async function processUploadedFile(filePath: string, uploaderId: string): Promise<UploadStatus> {
  const like = (trackId: string) =>
    prisma.favorite
      .upsert({
        where: { userId_trackId: { userId: uploaderId, trackId } },
        create: { userId: uploaderId, trackId },
        update: {},
      })
      .catch(() => {});
  try {
    // Reject anything that isn't genuinely MP3/FLAC (e.g. a renamed executable).
    if (!looksLikeAudio(filePath)) {
      fs.rmSync(filePath, { force: true });
      return "failed";
    }
    const r = await ingestFile(filePath, uploaderId, true /* dedupe */);
    if (!r) return "failed";
    await like(r.trackId); // uploads are auto-liked
    if (r.duplicate) {
      fs.rmSync(filePath, { force: true }); // same song already present
      return "duplicate";
    }
    if (r.created) {
      await fetchAndStoreLyrics(r.trackId).catch(() => {});
      return "added";
    }
    return "duplicate"; // unchanged file already at this path
  } catch (e) {
    fs.rmSync(filePath, { force: true });
    console.error(`[upload] ingest failed for ${filePath}:`, (e as Error).message);
    return "failed";
  }
}

function tally(statuses: { name: string; status: UploadStatus }[]) {
  const pick = (s: UploadStatus) => statuses.filter((x) => x.status === s).map((x) => x.name);
  const added = pick("added");
  const failed = pick("failed");
  const duplicates = pick("duplicate");
  return {
    added: added.length,
    failed: failed.length,
    duplicates: duplicates.length,
    addedNames: added,
    failedNames: failed,
    duplicateNames: duplicates,
  };
}

/** A fresh, collision-free absolute path under the uploads directory. */
function uniqueUploadPath(originalName: string): string {
  const dir = path.join(env.musicPath, "uploads");
  fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(originalName).replace(/[\\/:*?"<>|]/g, "_");
  let name = base;
  let i = 1;
  while (fs.existsSync(path.join(dir, name))) {
    const ext = path.extname(base);
    name = `${path.basename(base, ext)} (${i++})${ext}`;
  }
  return path.join(dir, name);
}

/** POST /api/library/upload (multipart "files") — add audio; uploader auto-likes it */
router.post("/upload", upload.array("files", 50), async (req, res) => {
  const files = (req.files as Express.Multer.File[]) ?? [];
  if (files.length === 0) return res.status(400).json({ error: "No audio files uploaded" });
  const uploaderId = req.user!.id;
  const results: { name: string; status: UploadStatus }[] = [];
  for (const f of files) {
    results.push({ name: f.originalname, status: await processUploadedFile(f.path, uploaderId) });
  }
  res.status(201).json(tally(results));
});

// ---- Chunked upload (for files larger than the CDN's request-body cap) -----
// Cloudflare caps a single request body at ~100MB, so large songs are uploaded
// in chunks (each well under the cap) and reassembled here.
const _chunkId = /^[A-Za-z0-9_-]{1,80}$/;
const chunkTmpDir = () => path.join(env.musicPath, "tmp");

/** POST /api/library/upload/chunk?uploadId=&index= — append one raw chunk. */
router.post(
  "/upload/chunk",
  express.raw({ type: () => true, limit: 120 * 1024 * 1024 }),
  (req, res) => {
    const uploadId = String(req.query.uploadId ?? "");
    const index = Number(req.query.index);
    if (!_chunkId.test(uploadId) || !Number.isInteger(index) || index < 0) {
      return res.status(400).json({ error: "Invalid chunk" });
    }
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return res.status(400).json({ error: "Empty chunk" });
    }
    const dir = chunkTmpDir();
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `${uploadId}.part`);
    // The first chunk truncates; the rest append (client uploads in order).
    if (index === 0) fs.writeFileSync(tmp, body);
    else fs.appendFileSync(tmp, body);
    res.status(204).end();
  },
);

/** POST /api/library/upload/finalize { uploadId, filename } — assemble + ingest. */
router.post("/upload/finalize", async (req, res) => {
  const parsed = z
    .object({ uploadId: z.string(), filename: z.string().min(1) })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });
  const { uploadId, filename } = parsed.data;
  const tmp = path.join(chunkTmpDir(), `${uploadId}.part`);
  if (!_chunkId.test(uploadId) || !fs.existsSync(tmp)) {
    return res.status(400).json({ error: "No upload data" });
  }
  if (!UPLOAD_EXT.has(path.extname(filename).toLowerCase())) {
    fs.rmSync(tmp, { force: true });
    return res.status(400).json({ error: "Only MP3 and FLAC files are allowed" });
  }
  const dest = uniqueUploadPath(filename);
  fs.renameSync(tmp, dest);
  const status = await processUploadedFile(dest, req.user!.id);
  res.status(201).json(tally([{ name: path.basename(filename), status }]));
});

export default router;
