import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { fetchAndStoreLyrics } from "../services/scanner.js";

const router = Router();
router.use(requireAuth);

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

export default router;
