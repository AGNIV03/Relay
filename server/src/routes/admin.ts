import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { runScan, getScanStatus, ingestFile, fetchAndStoreLyrics } from "../services/scanner.js";
import { env } from "../lib/env.js";

const router = Router();
router.use(requireAuth, requireAdmin);

const AUDIO_EXT = new Set([".mp3", ".flac", ".m4a", ".aac", ".ogg", ".opus", ".wav", ".wma", ".aiff", ".alac"]);

// Uploads are written verbatim to the music library — NO transcoding/compression,
// so original quality (incl. lossless FLAC/ALAC/WAV) is preserved byte-for-byte.
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
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2 GB/file — lossless can be large
  fileFilter: (_req, file, cb) =>
    cb(null, AUDIO_EXT.has(path.extname(file.originalname).toLowerCase())),
});

/** GET /api/admin/users */
router.get("/users", async (_req, res) => {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: "asc" },
    select: { id: true, username: true, role: true, createdAt: true },
  });
  res.json(users);
});

/** POST /api/admin/users { username, password, role } */
router.post("/users", async (req, res) => {
  const parsed = z
    .object({
      username: z.string().min(2).max(40),
      password: z.string().min(6).max(200),
      role: z.enum(["ADMIN", "USER"]).default("USER"),
    })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });

  const existing = await prisma.user.findUnique({ where: { username: parsed.data.username } });
  if (existing) return res.status(409).json({ error: "Username already taken" });

  const user = await prisma.user.create({
    data: {
      username: parsed.data.username,
      passwordHash: await bcrypt.hash(parsed.data.password, 10),
      role: parsed.data.role,
    },
    select: { id: true, username: true, role: true, createdAt: true },
  });
  res.status(201).json(user);
});

/** PATCH /api/admin/users/:id/role { role } — change a user's role */
router.patch("/users/:id/role", async (req, res) => {
  const parsed = z.object({ role: z.enum(["ADMIN", "USER"]) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });
  if (req.params.id === req.user!.id) {
    return res.status(400).json({ error: "You cannot change your own role" });
  }
  const user = await prisma.user
    .update({
      where: { id: req.params.id },
      data: { role: parsed.data.role },
      select: { id: true, username: true, role: true, createdAt: true },
    })
    .catch(() => null);
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json(user);
});

/** POST /api/admin/upload (multipart "files") — add audio to the library, lossless */
router.post("/upload", upload.array("files", 50), async (req, res) => {
  const files = (req.files as Express.Multer.File[]) ?? [];
  if (files.length === 0) return res.status(400).json({ error: "No audio files uploaded" });
  const added: string[] = [];
  const failed: string[] = [];
  for (const f of files) {
    try {
      const r = await ingestFile(f.path);
      if (r?.created) {
        added.push(f.originalname);
        await fetchAndStoreLyrics(r.trackId).catch(() => {});
      }
    } catch (e) {
      failed.push(f.originalname);
      console.error(`[upload] ingest failed for ${f.originalname}:`, (e as Error).message);
    }
  }
  res.status(201).json({ added: added.length, failed: failed.length, addedNames: added, failedNames: failed });
});

/** DELETE /api/admin/users/:id */
router.delete("/users/:id", async (req, res) => {
  if (req.params.id === req.user!.id) {
    return res.status(400).json({ error: "You cannot delete your own account" });
  }
  await prisma.user.delete({ where: { id: req.params.id } }).catch(() => {});
  res.status(204).end();
});

/** POST /api/admin/scan — trigger a library scan (runs async) */
router.post("/scan", async (_req, res) => {
  const status = getScanStatus();
  if (status.scanning) return res.status(409).json({ error: "Scan already running" });
  runScan().catch((e) => console.error("[scan] error:", e));
  res.status(202).json({ started: true });
});

/** GET /api/admin/scan — scan status + last result */
router.get("/scan", (_req, res) => {
  res.json(getScanStatus());
});

/** GET /api/admin/stats — library overview */
router.get("/stats", async (_req, res) => {
  const [tracks, albums, artists, users, playlists] = await Promise.all([
    prisma.track.count(),
    prisma.album.count(),
    prisma.artist.count(),
    prisma.user.count(),
    prisma.playlist.count(),
  ]);
  const durationAgg = await prisma.track.aggregate({ _sum: { duration: true, size: true } });
  res.json({
    tracks,
    albums,
    artists,
    users,
    playlists,
    totalDurationSec: Math.round(durationAgg._sum.duration ?? 0),
    totalSizeBytes: durationAgg._sum.size ?? 0,
  });
});

export default router;
