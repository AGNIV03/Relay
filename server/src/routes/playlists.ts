import { Router } from "express";
import { z } from "zod";
import multer from "multer";
import path from "node:path";
import { promises as fsp } from "node:fs";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { env } from "../lib/env.js";
import {
  generatePlaylistCollage,
  saveCustomPlaylistCover,
  refreshAutoCollage,
} from "../services/playlistCover.js";

const router = Router();
router.use(requireAuth);

const coverUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, file.mimetype.startsWith("image/")),
});

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
    refreshAutoCollage(playlist.id, playlist.coverCustom); // keep the collage fresh
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
  refreshAutoCollage(playlist.id, playlist.coverCustom);
  res.status(204).end();
});

// ---- Cover art ------------------------------------------------------------

/** GET /api/playlists/:id/cover — collage (auto-generated on demand) or custom image */
router.get("/:id/cover", async (req, res) => {
  const pl = await prisma.playlist.findFirst({
    where: { id: req.params.id, userId: req.user!.id },
  });
  if (!pl) return res.status(404).end();
  let rel = pl.coverPath;
  // Generate a collage lazily the first time (or if the file went missing).
  if (rel) {
    try {
      await fsp.access(path.resolve(env.dataPath, rel));
    } catch {
      rel = null;
    }
  }
  if (!rel) rel = await generatePlaylistCollage(pl.id).catch(() => null);
  if (!rel) return res.status(404).end();
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(path.resolve(env.dataPath, rel));
});

/** POST /api/playlists/:id/cover/regenerate — rebuild the auto collage */
router.post("/:id/cover/regenerate", async (req, res) => {
  const pl = await prisma.playlist.findFirst({
    where: { id: req.params.id, userId: req.user!.id },
  });
  if (!pl) return res.status(404).json({ error: "Not found" });
  await prisma.playlist.update({ where: { id: pl.id }, data: { coverCustom: false } });
  const rel = await generatePlaylistCollage(pl.id).catch(() => null);
  if (!rel) return res.status(422).json({ error: "No track covers to make a collage from" });
  res.json({ ok: true });
});

/** POST /api/playlists/:id/cover (multipart "cover") — upload a custom image */
router.post("/:id/cover", coverUpload.single("cover"), async (req, res) => {
  const pl = await prisma.playlist.findFirst({
    where: { id: req.params.id, userId: req.user!.id },
  });
  if (!pl) return res.status(404).json({ error: "Not found" });
  if (!req.file) return res.status(400).json({ error: "No image uploaded" });
  try {
    await saveCustomPlaylistCover(pl.id, req.file.buffer);
    res.json({ ok: true });
  } catch {
    res.status(400).json({ error: "Could not process image" });
  }
});

export default router;
