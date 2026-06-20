import { Router } from "express";
import { z } from "zod";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { fetchAndStoreLyrics, ingestFile } from "../services/scanner.js";
import { env } from "../lib/env.js";

const router = Router();
router.use(requireAuth);

const AUDIO_EXT = new Set([".mp3", ".flac", ".m4a", ".aac", ".ogg", ".opus", ".wav", ".wma", ".aiff", ".alac"]);

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
    cb(null, AUDIO_EXT.has(path.extname(file.originalname).toLowerCase())),
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
      include: { artist: true, album: true },
    }),
    prisma.track.count({ where }),
  ]);
  res.json({ tracks, total, limit, offset });
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

/** GET /api/library/tracks/:id/lyrics — synced (LRC) + plain; fetches on demand if unchecked */
router.get("/tracks/:id/lyrics", async (req, res) => {
  let track = await prisma.track.findUnique({ where: { id: req.params.id } });
  if (!track) return res.status(404).json({ error: "Not found" });
  if (!track.lyricsChecked) {
    await fetchAndStoreLyrics(track.id).catch(() => {});
    track = await prisma.track.findUnique({ where: { id: req.params.id } });
  }
  res.json({ synced: track?.lyricsSynced ?? null, plain: track?.lyricsPlain ?? null });
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

/** POST /api/library/upload (multipart "files") — add audio; uploader auto-likes it */
router.post("/upload", upload.array("files", 50), async (req, res) => {
  const files = (req.files as Express.Multer.File[]) ?? [];
  if (files.length === 0) return res.status(400).json({ error: "No audio files uploaded" });
  const uploaderId = req.user!.id;
  const added: string[] = [];
  const failed: string[] = [];
  for (const f of files) {
    try {
      const r = await ingestFile(f.path, uploaderId);
      if (r) {
        // Auto-like every uploaded track for its uploader.
        await prisma.favorite
          .upsert({
            where: { userId_trackId: { userId: uploaderId, trackId: r.trackId } },
            create: { userId: uploaderId, trackId: r.trackId },
            update: {},
          })
          .catch(() => {});
        if (r.created) {
          added.push(f.originalname);
          await fetchAndStoreLyrics(r.trackId).catch(() => {});
        }
      }
    } catch (e) {
      failed.push(f.originalname);
      console.error(`[upload] ingest failed for ${f.originalname}:`, (e as Error).message);
    }
  }
  res.status(201).json({ added: added.length, failed: failed.length, addedNames: added, failedNames: failed });
});

export default router;
