import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

/** GET /api/search?q=... — searches tracks, albums, and artists */
router.get("/", requireAuth, async (req, res) => {
  const q = (req.query.q as string | undefined)?.trim();
  if (!q) return res.json({ tracks: [], albums: [], artists: [] });

  const contains = { contains: q, mode: "insensitive" as const };

  const [tracks, albums, artists] = await Promise.all([
    prisma.track.findMany({
      where: { title: contains },
      take: 30,
      include: { artist: true, album: true },
    }),
    prisma.album.findMany({
      where: { title: contains },
      take: 20,
      include: { artist: true, _count: { select: { tracks: true } } },
    }),
    prisma.artist.findMany({
      where: { name: contains },
      take: 20,
      include: { _count: { select: { albums: true, tracks: true } } },
    }),
  ]);

  res.json({ tracks, albums, artists });
});

export default router;
