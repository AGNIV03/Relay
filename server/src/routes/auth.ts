import { Router } from "express";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { signAccessToken, signRefreshToken, verifyToken, tokenVersionOf } from "../lib/jwt.js";
import { requireAuth, invalidateAuthCache } from "../middleware/auth.js";

const router = Router();

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

// Compared against when the username doesn't exist, so a miss costs the same
// bcrypt time as a wrong password and response timing doesn't reveal which
// usernames are valid. Same cost factor (12) as real hashes.
const DUMMY_HASH = bcrypt.hashSync(randomBytes(16).toString("hex"), 12);

// ---- Per-username failed-login backoff -------------------------------------
// The IP rate limiter (index.ts) can be dodged by spreading guesses over many
// IPs, so failures are also counted per *username* (existing or not — keyed the
// same either way so a lockout doesn't reveal whether the account exists). After
// FREE_ATTEMPTS consecutive failures each further attempt must wait 30s, 60s,
// 120s… capped at 15 min. A successful login resets the counter. In-memory.
const FREE_ATTEMPTS = 5;
const BASE_LOCK_MS = 30_000;
const MAX_LOCK_MS = 15 * 60_000;
const FAIL_MAX_ENTRIES = 10_000;
const FAIL_FORGET_MS = 24 * 60 * 60_000; // forget a counter a day after its last failure
const failures = new Map<string, { count: number; last: number; lockedUntil: number }>();

const failKey = (username: string) => username.trim().toLowerCase();

function lockedOut(username: string): boolean {
  const f = failures.get(failKey(username));
  return !!f && f.lockedUntil > Date.now();
}

function recordFailure(username: string) {
  const key = failKey(username);
  const now = Date.now();
  if (!failures.has(key) && failures.size >= FAIL_MAX_ENTRIES) {
    for (const [k, v] of failures) if (now - v.last > FAIL_FORGET_MS) failures.delete(k);
    // Still full → evict the oldest entries (Map iterates in insertion order).
    for (const k of failures.keys()) {
      if (failures.size < FAIL_MAX_ENTRIES) break;
      failures.delete(k);
    }
  }
  const prev = failures.get(key);
  const count = prev && now - prev.last <= FAIL_FORGET_MS ? prev.count + 1 : 1;
  const lockedUntil =
    count >= FREE_ATTEMPTS
      ? now + Math.min(BASE_LOCK_MS * 2 ** (count - FREE_ATTEMPTS), MAX_LOCK_MS)
      : 0;
  failures.delete(key); // re-insert so insertion order tracks recency
  failures.set(key, { count, last: now, lockedUntil });
}

/** The token pair + user shape returned by /login and /change-password. */
function sessionFor(user: { id: string; username: string; role: "ADMIN" | "USER"; tokenVersion: number }) {
  return {
    accessToken: signAccessToken(user.id, user.role, user.tokenVersion),
    refreshToken: signRefreshToken(user.id, user.role, user.tokenVersion),
    user: { id: user.id, username: user.username, role: user.role },
  };
}

router.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });
  const { username, password } = parsed.data;

  if (lockedOut(username)) {
    return res.status(429).json({ error: "Too many failed attempts — please try again later." });
  }

  const user = await prisma.user.findUnique({ where: { username } });
  // Always run exactly one bcrypt compare (dummy hash for unknown users).
  const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !ok) {
    recordFailure(username);
    return res.status(401).json({ error: "Invalid username or password" });
  }

  failures.delete(failKey(username));
  res.json(sessionFor(user));
});

router.post("/refresh", async (req, res) => {
  const token = z.object({ refreshToken: z.string() }).safeParse(req.body);
  if (!token.success) return res.status(400).json({ error: "Invalid input" });
  try {
    const payload = verifyToken(token.data.refreshToken);
    if (payload.type !== "refresh") return res.status(401).json({ error: "Invalid token type" });
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) return res.status(401).json({ error: "User no longer exists" });
    // Revoked (password change / sign out everywhere / role change).
    if (tokenVersionOf(payload) !== user.tokenVersion) {
      return res.status(401).json({ error: "Invalid or expired refresh token" });
    }
    res.json({
      accessToken: signAccessToken(user.id, user.role, user.tokenVersion),
      refreshToken: signRefreshToken(user.id, user.role, user.tokenVersion),
    });
  } catch {
    return res.status(401).json({ error: "Invalid or expired refresh token" });
  }
});

/** POST /api/auth/change-password { currentPassword, newPassword }
 *  Revokes every other session (bumps tokenVersion) and returns a fresh token
 *  pair for the caller: { ok, accessToken, refreshToken, user }. */
router.post("/change-password", requireAuth, async (req, res) => {
  const parsed = z
    .object({
      currentPassword: z.string().min(1),
      newPassword: z.string().min(10).max(200),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "New password must be at least 10 characters" });
  }
  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!user) return res.status(404).json({ error: "Not found" });
  if (!(await bcrypt.compare(parsed.data.currentPassword, user.passwordHash))) {
    // 403, not 401: a 401 makes clients think their token expired and refresh.
    return res.status(403).json({ error: "Current password is incorrect" });
  }
  const passwordHash = await bcrypt.hash(parsed.data.newPassword, 12);
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash, tokenVersion: { increment: 1 } },
  });
  invalidateAuthCache(user.id);
  res.json({ ok: true, ...sessionFor(updated) });
});

/** POST /api/auth/logout-all — "sign out of all devices": revokes every token
 *  this user holds, including the caller's. */
router.post("/logout-all", requireAuth, async (req, res) => {
  await prisma.user.update({
    where: { id: req.user!.id },
    data: { tokenVersion: { increment: 1 } },
  });
  invalidateAuthCache(req.user!.id);
  res.status(204).end();
});

router.get("/me", requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: {
      id: true,
      username: true,
      role: true,
      createdAt: true,
      shareActivity: true,
      allowListenAlong: true,
    },
  });
  if (!user) return res.status(404).json({ error: "Not found" });
  res.json(user);
});

export default router;
