import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth);

/** GET /api/playlists — current user's playlists, most-played first */
router.get("/", async (req, res) => {
  const userId = req.user!.id;
  const playlists = await prisma.playlist.findMany({
    where: { userId },
    include: {
      _count: { select: { tracks: true } },
      tracks: { select: { trackId: true } },
    },
  });
  // How many times the user has played each track, to rank playlists by total plays.
  const history = await prisma.playHistory.groupBy({
    by: ["trackId"],
    where: { userId },
    _count: { trackId: true },
  });
  const counts = new Map(history.map((h) => [h.trackId, h._count.trackId]));
  const ranked = playlists
    .map((pl) => {
      const playCount = pl.tracks.reduce((sum, t) => sum + (counts.get(t.trackId) ?? 0), 0);
      const { tracks: _tracks, ...rest } = pl; // omit the id list from the response
      return { ...rest, playCount };
    })
    .sort((a, b) => b.playCount - a.playCount || b.createdAt.getTime() - a.createdAt.getTime());
  res.json(ranked);
});

/** GET /api/playlists/:id — playlist with ordered tracks */
router.get("/:id", async (req, res) => {
  const playlist = await prisma.playlist.findFirst({
    where: { id: req.params.id, userId: req.user!.id },
    include: {
      tracks: {
        orderBy: { position: "asc" },
        include: { track: { include: { artist: true, album: true } } },
      },
    },
  });
  if (!playlist) return res.status(404).json({ error: "Not found" });
  res.json(playlist);
});

/** POST /api/playlists { name } */
router.post("/", async (req, res) => {
  const parsed = z.object({ name: z.string().min(1).max(120) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });
  const playlist = await prisma.playlist.create({
    data: { name: parsed.data.name, userId: req.user!.id },
  });
  res.status(201).json(playlist);
});

/** DELETE /api/playlists/:id */
router.delete("/:id", async (req, res) => {
  const result = await prisma.playlist.deleteMany({
    where: { id: req.params.id, userId: req.user!.id },
  });
  if (result.count === 0) return res.status(404).json({ error: "Not found" });
  res.status(204).end();
});

/** POST /api/playlists/:id/tracks { trackId } — append a track */
router.post("/:id/tracks", async (req, res) => {
  const parsed = z.object({ trackId: z.string() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });

  const playlist = await prisma.playlist.findFirst({
    where: { id: req.params.id, userId: req.user!.id },
  });
  if (!playlist) return res.status(404).json({ error: "Not found" });

  const last = await prisma.playlistTrack.findFirst({
    where: { playlistId: playlist.id },
    orderBy: { position: "desc" },
  });
  const position = (last?.position ?? -1) + 1;

  try {
    const item = await prisma.playlistTrack.create({
      data: { playlistId: playlist.id, trackId: parsed.data.trackId, position },
    });
    res.status(201).json(item);
  } catch {
    res.status(409).json({ error: "Track already in playlist" });
  }
});

/** DELETE /api/playlists/:id/tracks/:trackId */
router.delete("/:id/tracks/:trackId", async (req, res) => {
  const playlist = await prisma.playlist.findFirst({
    where: { id: req.params.id, userId: req.user!.id },
  });
  if (!playlist) return res.status(404).json({ error: "Not found" });
  await prisma.playlistTrack.deleteMany({
    where: { playlistId: playlist.id, trackId: req.params.trackId },
  });
  res.status(204).end();
});

export default router;
