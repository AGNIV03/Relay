import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { runScan, getScanStatus } from "../services/scanner.js";

const router = Router();
router.use(requireAuth, requireAdmin);

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
