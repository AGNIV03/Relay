import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireAdmin, invalidateAuthCache } from "../middleware/auth.js";
import { runScan, getScanStatus, ingestFile, fetchAndStoreLyrics } from "../services/scanner.js";
import { env } from "../lib/env.js";
import { recordRejection } from "../services/ingestLog.js";
import { queueLoudness } from "../services/loudness.js";
import { getStorageStats } from "../services/storageStats.js";
import { autotagEnabled } from "../services/autotag.js";
import { getActivity, isOnline } from "../lib/presence.js";
import { generateInviteCode, countActiveInvites } from "../lib/invites.js";

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
  fileFilter: (req, file, cb) => {
    const ok = AUDIO_EXT.has(path.extname(file.originalname).toLowerCase());
    if (!ok) recordRejection(file.originalname, "Unsupported file type", "admin", req.user?.id);
    cb(null, ok);
  },
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
      password: z.string().min(10).max(200),
      role: z.enum(["ADMIN", "USER"]).default("USER"),
    })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });

  const existing = await prisma.user.findUnique({ where: { username: parsed.data.username } });
  if (existing) return res.status(409).json({ error: "Username already taken" });

  const user = await prisma.user.create({
    data: {
      username: parsed.data.username,
      passwordHash: await bcrypt.hash(parsed.data.password, 12),
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
  // Bumping tokenVersion revokes the user's existing tokens so they re-login with
  // the new role (requireAuth reads the role from the DB anyway; this also stops
  // clients from caching a stale role).
  const user = await prisma.user
    .update({
      where: { id: req.params.id },
      data: { role: parsed.data.role, tokenVersion: { increment: 1 } },
      select: { id: true, username: true, role: true, createdAt: true },
    })
    .catch(() => null);
  invalidateAuthCache(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json(user);
});

/** POST /api/admin/upload (multipart "files") — add audio to the library, lossless */
router.post("/upload", upload.array("files", 50), async (req, res) => {
  // Imported here (already-loaded modules, so this is cheap) to keep this
  // handler self-contained.
  const { looksLikeAudio, IngestRejectedError } = await import("../services/audioCheck.js");
  const { queueAutotag } = await import("../services/autotag.js");
  const files = (req.files as Express.Multer.File[]) ?? [];
  if (files.length === 0) return res.status(400).json({ error: "No audio files uploaded" });
  const added: string[] = [];
  const failed: string[] = [];
  const duplicates: string[] = [];
  const rejected: { name: string; reason: string }[] = [];
  const drop = (p: string) => fs.rmSync(p, { force: true });
  for (const f of files) {
    try {
      // Same magic-byte sniff as user uploads (a renamed executable isn't audio).
      if (!looksLikeAudio(f.path)) {
        drop(f.path);
        failed.push(f.originalname);
        rejected.push({ name: f.originalname, reason: "Not a recognised audio file" });
        recordRejection(f.originalname, "Not a recognised audio file", "admin", req.user!.id);
        continue;
      }
      const r = await ingestFile(f.path);
      if (!r) {
        drop(f.path);
        failed.push(f.originalname);
      } else if (r.duplicate) {
        drop(f.path); // byte-identical to a track already in the library
        duplicates.push(f.originalname);
      } else if (r.created) {
        added.push(f.originalname);
        await fetchAndStoreLyrics(r.trackId).catch(() => {});
        queueAutotag(r.trackId); // background; no-op unless enabled
        queueLoudness(r.trackId); // background
      } else {
        duplicates.push(f.originalname); // already in the library (file kept: it's in use)
      }
    } catch (e) {
      drop(f.path); // don't leave unusable files behind in the library
      failed.push(f.originalname);
      if (e instanceof IngestRejectedError) {
        rejected.push({ name: f.originalname, reason: e.reason });
        console.warn(`[upload] rejected ${f.originalname}: ${e.reason}`);
        recordRejection(f.originalname, e.reason, "admin", req.user!.id);
      } else {
        console.error(`[upload] ingest failed for ${f.originalname}:`, (e as Error).message);
      }
    }
  }
  res.status(201).json({
    added: added.length,
    failed: failed.length,
    addedNames: added,
    failedNames: failed,
    duplicates: duplicates.length,
    duplicateNames: duplicates,
    rejected,
  });
});

/** DELETE /api/admin/users/:id */
router.delete("/users/:id", async (req, res) => {
  if (req.params.id === req.user!.id) {
    return res.status(400).json({ error: "You cannot delete your own account" });
  }
  await prisma.user.delete({ where: { id: req.params.id } }).catch(() => {});
  invalidateAuthCache(req.params.id); // their tokens stop working immediately
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

// ---- Invites -----------------------------------------------------------------

/** GET /api/admin/invites -> InviteCode[] (newest first, with createdBy {username}) */
router.get("/invites", async (_req, res) => {
  const invites = await prisma.inviteCode.findMany({
    orderBy: { createdAt: "desc" },
    take: 500,
    include: { createdBy: { select: { username: true } } },
  });
  res.json(invites);
});

/** POST /api/admin/invites { role?, maxUses? (1..1000), expiresInDays? (1..365) | null, note? } -> InviteCode */
router.post("/invites", async (req, res) => {
  const parsed = z
    .object({
      role: z.enum(["ADMIN", "USER"]).default("USER"),
      maxUses: z.number().int().min(1).max(1000).default(1),
      expiresInDays: z.number().int().min(1).max(365).nullable().optional(),
      note: z.string().trim().max(200).nullable().optional(),
    })
    .safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });
  const { role, maxUses, expiresInDays, note } = parsed.data;
  const expiresAt = expiresInDays ? new Date(Date.now() + expiresInDays * 24 * 60 * 60_000) : null;
  // Retry on the (astronomically unlikely) code collision.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const invite = await prisma.inviteCode.create({
        data: {
          code: generateInviteCode(),
          role,
          maxUses,
          expiresAt,
          note: note || null,
          createdById: req.user!.id,
        },
        include: { createdBy: { select: { username: true } } },
      });
      return res.status(201).json(invite);
    } catch (e) {
      if ((e as { code?: string }).code !== "P2002") throw e;
    }
  }
  res.status(500).json({ error: "Could not create invite" });
});

/** DELETE /api/admin/invites/:id — revoke (kept for the record). -> 204 */
router.delete("/invites/:id", async (req, res) => {
  const r = await prisma.inviteCode.updateMany({
    where: { id: req.params.id },
    data: { revokedAt: new Date() },
  });
  if (r.count === 0) return res.status(404).json({ error: "Not found" });
  res.status(204).end();
});

// ---- Dashboard ----------------------------------------------------------------

/** GET /api/admin/dashboard — storage, library + listening counts, scan status,
 *  per-user activity, recent ingest rejections, feature flags. */
router.get("/dashboard", async (_req, res) => {
  const now = Date.now();
  const day = new Date(now - 24 * 60 * 60_000);
  const week = new Date(now - 7 * 24 * 60 * 60_000);
  const [
    storage,
    tracks,
    albums,
    artists,
    userCount,
    playlists,
    plays24h,
    plays7d,
    durationAgg,
    users,
    lastPlays,
    weekPlays,
    uploads,
    rejections,
    autotag,
    activeInvites,
  ] = await Promise.all([
    getStorageStats(),
    prisma.track.count(),
    prisma.album.count(),
    prisma.artist.count(),
    prisma.user.count(),
    prisma.playlist.count(),
    prisma.playHistory.count({ where: { playedAt: { gte: day } } }),
    prisma.playHistory.count({ where: { playedAt: { gte: week } } }),
    prisma.track.aggregate({ _sum: { duration: true } }),
    prisma.user.findMany({
      orderBy: { createdAt: "asc" },
      select: { id: true, username: true, role: true, createdAt: true },
    }),
    prisma.playHistory.groupBy({ by: ["userId"], _max: { playedAt: true } }),
    prisma.playHistory.groupBy({
      by: ["userId"],
      where: { playedAt: { gte: week } },
      _count: { userId: true },
    }),
    prisma.track.groupBy({
      by: ["uploaderId"],
      where: { uploaderId: { not: null } },
      _count: { uploaderId: true },
    }),
    prisma.ingestRejection.findMany({ orderBy: { createdAt: "desc" }, take: 50 }),
    autotagEnabled().catch(() => false),
    countActiveInvites(),
  ]);

  const lastPlayBy = new Map(lastPlays.map((g) => [g.userId, g._max.playedAt]));
  const weekBy = new Map(weekPlays.map((g) => [g.userId, g._count.userId]));
  const uploadsBy = new Map(uploads.map((g) => [g.uploaderId, g._count.uploaderId]));
  const nameBy = new Map(users.map((u) => [u.id, u.username]));
  const scan = getScanStatus();

  res.json({
    storage,
    counts: {
      tracks,
      albums,
      artists,
      users: userCount,
      playlists,
      plays24h,
      plays7d,
      // Total length of the library, in minutes.
      totalMinutes: Math.round((durationAgg._sum.duration ?? 0) / 60),
    },
    scan: { running: scan.scanning, lastResult: scan.lastResult ?? null },
    users: users.map((u) => {
      const a = getActivity(u.id);
      const played = lastPlayBy.get(u.id)?.getTime() ?? 0;
      const seen = Math.max(played, a?.updatedAt ?? 0);
      return {
        ...u,
        lastSeenAt: seen ? new Date(seen).toISOString() : null,
        online: isOnline(a),
        plays7d: weekBy.get(u.id) ?? 0,
        uploads: uploadsBy.get(u.id) ?? 0,
      };
    }),
    rejections: rejections.map((r) => ({
      id: r.id,
      name: r.name,
      reason: r.reason,
      source: r.source,
      username: r.userId ? (nameBy.get(r.userId) ?? null) : null,
      createdAt: r.createdAt,
    })),
    autotag: { enabled: autotag },
    invites: { active: activeInvites },
  });
});

export default router;
