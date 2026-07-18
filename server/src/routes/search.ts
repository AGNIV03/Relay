import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { rankTracks, rankByName } from "../lib/search.js";

const router = Router();

/** GET /api/search?q=... — searches tracks, albums, and artists */
router.get("/", requireAuth, async (req, res) => {
  const q = (req.query.q as string | undefined)?.trim();
  if (!q) return res.json({ tracks: [], albums: [], artists: [] });

  const contains = { contains: q, mode: "insensitive" as const };

  // Match on title/artist/album (not just title) so a search finds tracks by any
  // of them, then rank by relevance and keep the top results.
  const [trackMatches, albumMatches, artistMatches] = await Promise.all([
    prisma.track.findMany({
      where: {
        OR: [{ title: contains }, { artist: { name: contains } }, { album: { title: contains } }],
      },
      take: 500,
      include: { artist: true, album: true },
    }),
    prisma.album.findMany({
      where: { title: contains },
      take: 100,
      include: { artist: true, _count: { select: { tracks: true } } },
    }),
    prisma.artist.findMany({
      where: { name: contains },
      take: 100,
      include: { _count: { select: { albums: true, tracks: true } } },
    }),
  ]);

  const tracks = rankTracks(trackMatches, q).slice(0, 30);
  const albums = rankByName(albumMatches, q).slice(0, 20);
  const artists = rankByName(artistMatches, q).slice(0, 20);

  res.json({ tracks, albums, artists });
});

export default router;
