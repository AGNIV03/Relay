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

/** A playlist the user may view + edit tracks on: the owner OR a collaborator. */
function accessibleWhere(id: string, userId: string) {
  return { id, OR: [{ userId }, { collaborators: { some: { userId } } }] };
}

/** GET /api/playlists — playlists the user owns OR collaborates on, most-played first */
router.get("/", async (req, res) => {
  const userId = req.user!.id;
  const playlists = await prisma.playlist.findMany({
    where: { OR: [{ userId }, { collaborators: { some: { userId } } }] },
    include: {
      _count: { select: { tracks: true } },
      tracks: { select: { trackId: true } },
      user: { select: { username: true } },
      collaborators: { select: { userId: true } },
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
      const { tracks: _tracks, user, collaborators, ...rest } = pl;
      return {
        ...rest,
        playCount,
        owned: pl.userId === userId,
        ownerName: user.username,
        collaboratorCount: collaborators.length,
      };
    })
    .sort((a, b) => b.playCount - a.playCount || b.createdAt.getTime() - a.createdAt.getTime());
  res.json(ranked);
});

/** GET /api/playlists/:id — playlist with ordered tracks (owner or collaborator) */
router.get("/:id", async (req, res) => {
  const playlist = await prisma.playlist.findFirst({
    where: accessibleWhere(req.params.id, req.user!.id),
    include: {
      tracks: {
        orderBy: { position: "asc" },
        include: { track: { include: { artist: true, album: true } } },
      },
      user: { select: { id: true, username: true } },
      collaborators: { include: { user: { select: { id: true, username: true } } } },
    },
  });
  if (!playlist) return res.status(404).json({ error: "Not found" });
  const { user, collaborators, ...rest } = playlist;
  res.json({
    ...rest,
    owned: playlist.userId === req.user!.id,
    owner: user,
    collaborators: collaborators.map((c) => c.user),
  });
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

/** PATCH /api/playlists/:id { name } — rename (owner only) */
router.patch("/:id", async (req, res) => {
  const parsed = z.object({ name: z.string().min(1).max(120) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });
  const result = await prisma.playlist.updateMany({
    where: { id: req.params.id, userId: req.user!.id },
    data: { name: parsed.data.name },
  });
  if (result.count === 0) return res.status(404).json({ error: "Not found" });
  res.json({ ok: true });
});

/** DELETE /api/playlists/:id — owner only */
router.delete("/:id", async (req, res) => {
  const result = await prisma.playlist.deleteMany({
    where: { id: req.params.id, userId: req.user!.id },
  });
  if (result.count === 0) return res.status(404).json({ error: "Not found" });
  res.status(204).end();
});

// ---- Collaborators --------------------------------------------------------

/** GET /api/playlists/:id/collaborators — owner + collaborators (owner or collaborator may view) */
router.get("/:id/collaborators", async (req, res) => {
  const pl = await prisma.playlist.findFirst({
    where: accessibleWhere(req.params.id, req.user!.id),
    include: {
      user: { select: { id: true, username: true } },
      collaborators: { include: { user: { select: { id: true, username: true } } } },
    },
  });
  if (!pl) return res.status(404).json({ error: "Not found" });
  res.json({ owner: pl.user, collaborators: pl.collaborators.map((c) => c.user) });
});

/** POST /api/playlists/:id/collaborators { userId } — add a collaborator (owner only) */
router.post("/:id/collaborators", async (req, res) => {
  const parsed = z.object({ userId: z.string() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });
  const pl = await prisma.playlist.findFirst({
    where: { id: req.params.id, userId: req.user!.id },
  });
  if (!pl) return res.status(404).json({ error: "Not found" });
  if (parsed.data.userId === req.user!.id) {
    return res.status(400).json({ error: "You already own this playlist" });
  }
  const target = await prisma.user.findUnique({ where: { id: parsed.data.userId } });
  if (!target) return res.status(404).json({ error: "User not found" });
  await prisma.playlistCollaborator.upsert({
    where: { playlistId_userId: { playlistId: pl.id, userId: parsed.data.userId } },
    create: { playlistId: pl.id, userId: parsed.data.userId },
    update: {},
  });
  res.status(201).json({ ok: true });
});

/** DELETE /api/playlists/:id/collaborators/:userId — remove a collaborator (owner only) */
router.delete("/:id/collaborators/:userId", async (req, res) => {
  const pl = await prisma.playlist.findFirst({
    where: { id: req.params.id, userId: req.user!.id },
  });
  if (!pl) return res.status(404).json({ error: "Not found" });
  await prisma.playlistCollaborator.deleteMany({
    where: { playlistId: pl.id, userId: req.params.userId },
  });
  res.status(204).end();
});

// ---- Tracks (owner or collaborator) ---------------------------------------

/** POST /api/playlists/:id/tracks { trackId } — append a track */
router.post("/:id/tracks", async (req, res) => {
  const parsed = z.object({ trackId: z.string() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });

  const playlist = await prisma.playlist.findFirst({
    where: accessibleWhere(req.params.id, req.user!.id),
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
    where: accessibleWhere(req.params.id, req.user!.id),
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
    where: accessibleWhere(req.params.id, req.user!.id),
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

/** POST /api/playlists/:id/cover/regenerate — rebuild the auto collage (owner only) */
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

/** POST /api/playlists/:id/cover (multipart "cover") — upload a custom image (owner only) */
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
