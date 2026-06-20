import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";

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

/** GET /api/library/artists/:id — artist with albums + tracks */
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

/** GET /api/library/albums/:id — album with its tracks in order */
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

/** GET /api/library/tracks?limit=&offset= — flat track list */
router.get("/tracks", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const offset = Number(req.query.offset) || 0;
  const [tracks, total] = await Promise.all([
    prisma.track.findMany({
      orderBy: { title: "asc" },
      skip: offset,
      take: limit,
      include: { artist: true, album: true },
    }),
    prisma.track.count(),
  ]);
  res.json({ tracks, total, limit, offset });
});

export default router;
