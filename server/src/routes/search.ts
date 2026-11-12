import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { rankTracks, rankByName } from "../lib/search.js";
import { qstr } from "../lib/query.js";

const router = Router();

/** GET /api/search?q=... — searches tracks, albums, artists and playlists (the
 *  user's own, ones they collaborate on, and public ones) */
router.get("/", requireAuth, async (req, res) => {
  const q = qstr(req.query.q)?.trim();
  if (!q) return res.json({ tracks: [], albums: [], artists: [], playlists: [] });
  const me = req.user!.id;

  const contains = { contains: q, mode: "insensitive" as const };

  // Match on title/artist/album (not just title) so a search finds tracks by any
  // of them, then rank by relevance and keep the top results.
  const [trackMatches, albumMatches, artistMatches, playlistMatches] = await Promise.all([
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
    prisma.playlist.findMany({
      where: {
        name: contains,
        OR: [{ userId: me }, { collaborators: { some: { userId: me } } }, { isPublic: true }],
      },
      take: 100,
      include: { _count: { select: { tracks: true } }, user: { select: { username: true } } },
    }),
  ]);

  const tracks = rankTracks(trackMatches, q).slice(0, 30);
  const albums = rankByName(albumMatches, q).slice(0, 20);
  const artists = rankByName(artistMatches, q).slice(0, 20);
  const playlists = rankByName(playlistMatches, q)
    .slice(0, 20)
    .map((p) => ({ id: p.id, name: p.name, trackCount: p._count.tracks, ownerName: p.user.username }));

  res.json({ tracks, albums, artists, playlists });
});

export default router;
