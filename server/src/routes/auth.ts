import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { signAccessToken, signRefreshToken, verifyToken } from "../lib/jwt.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

router.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });

  const user = await prisma.user.findUnique({ where: { username: parsed.data.username } });
  if (!user || !(await bcrypt.compare(parsed.data.password, user.passwordHash))) {
    return res.status(401).json({ error: "Invalid username or password" });
  }

  res.json({
    accessToken: signAccessToken(user.id, user.role),
    refreshToken: signRefreshToken(user.id, user.role),
    user: { id: user.id, username: user.username, role: user.role },
  });
});

router.post("/refresh", async (req, res) => {
  const token = z.object({ refreshToken: z.string() }).safeParse(req.body);
  if (!token.success) return res.status(400).json({ error: "Invalid input" });
  try {
    const payload = verifyToken(token.data.refreshToken);
    if (payload.type !== "refresh") return res.status(401).json({ error: "Invalid token type" });
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) return res.status(401).json({ error: "User no longer exists" });
    res.json({
      accessToken: signAccessToken(user.id, user.role),
      refreshToken: signRefreshToken(user.id, user.role),
    });
  } catch {
    return res.status(401).json({ error: "Invalid or expired refresh token" });
  }
});

/** POST /api/auth/change-password { currentPassword, newPassword } */
router.post("/change-password", requireAuth, async (req, res) => {
  const parsed = z
    .object({
      currentPassword: z.string().min(1),
      newPassword: z.string().min(6).max(200),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "New password must be at least 6 characters" });
  }
  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!user) return res.status(404).json({ error: "Not found" });
  if (!(await bcrypt.compare(parsed.data.currentPassword, user.passwordHash))) {
    return res.status(401).json({ error: "Current password is incorrect" });
  }
  const passwordHash = await bcrypt.hash(parsed.data.newPassword, 12);
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });
  res.json({ ok: true });
});

router.get("/me", requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: { id: true, username: true, role: true, createdAt: true },
  });
  if (!user) return res.status(404).json({ error: "Not found" });
  res.json(user);
});

export default router;
