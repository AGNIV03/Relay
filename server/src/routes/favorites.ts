import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth);

/** GET /api/favorites — current user's favorited tracks */
router.get("/", async (req, res) => {
  const favorites = await prisma.favorite.findMany({
    where: { userId: req.user!.id },
    orderBy: { createdAt: "desc" },
    include: { track: { include: { artist: true, album: true } } },
  });
  res.json(favorites.map((f) => f.track));
});

/** PUT /api/favorites/:trackId — mark favorite (idempotent) */
router.put("/:trackId", async (req, res) => {
  try {
    await prisma.favorite.create({
      data: { userId: req.user!.id, trackId: req.params.trackId },
    });
  } catch {
    // already favorited — ignore
  }
  res.status(204).end();
});

/** DELETE /api/favorites/:trackId */
router.delete("/:trackId", async (req, res) => {
  await prisma.favorite.deleteMany({
    where: { userId: req.user!.id, trackId: req.params.trackId },
  });
  res.status(204).end();
});

/** POST /api/favorites/scrobble { trackId } — record a play */
router.post("/scrobble", async (req, res) => {
  const parsed = z.object({ trackId: z.string() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });
  await prisma.playHistory.create({
    data: { userId: req.user!.id, trackId: parsed.data.trackId },
  });
  res.status(204).end();
});

export default router;
