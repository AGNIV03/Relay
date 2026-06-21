import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { setActivity, getActivity, isOnline } from "../lib/presence.js";

const router = Router();
router.use(requireAuth);

/** POST /api/social/activity — heartbeat with the user's current playback state */
router.post("/activity", (req, res) => {
  const parsed = z
    .object({
      trackId: z.string().nullable().optional(),
      positionMs: z.number().int().nonnegative().optional(),
      playing: z.boolean().optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });
  setActivity(req.user!.id, {
    trackId: parsed.data.trackId ?? null,
    positionMs: parsed.data.positionMs ?? 0,
    playing: parsed.data.playing ?? false,
  });
  res.status(204).end();
});

/** GET /api/social/friends — every other user + what they're (or were) playing */
router.get("/friends", async (req, res) => {
  const me = req.user!.id;
  const users = await prisma.user.findMany({
    where: { id: { not: me } },
    select: { id: true, username: true },
  });
  const acts = users.map((u) => ({ u, a: getActivity(u.id) }));
  const trackIds = [
    ...new Set(acts.map((x) => x.a?.trackId).filter((t): t is string => !!t)),
  ];
  const tracks = trackIds.length
    ? await prisma.track.findMany({
        where: { id: { in: trackIds } },
        include: { artist: true, album: true },
      })
    : [];
  const byId = new Map(tracks.map((t) => [t.id, t]));
  const friends = acts.map(({ u, a }) => ({
    id: u.id,
    username: u.username,
    online: isOnline(a),
    playing: a?.playing ?? false,
    track: a?.trackId ? byId.get(a.trackId) ?? null : null,
    updatedAt: a?.updatedAt ?? null,
  }));
  friends.sort(
    (x, y) => Number(y.online) - Number(x.online) || (y.updatedAt ?? 0) - (x.updatedAt ?? 0),
  );
  res.json(friends);
});

/** GET /api/social/activity/:userId — a user's live state, for "listen along" polling */
router.get("/activity/:userId", async (req, res) => {
  const a = getActivity(req.params.userId);
  const track = a?.trackId
    ? await prisma.track.findUnique({
        where: { id: a.trackId },
        include: { artist: true, album: true },
      })
    : null;
  res.json({
    trackId: a?.trackId ?? null,
    track,
    positionMs: a?.positionMs ?? 0,
    playing: a?.playing ?? false,
    updatedAt: a?.updatedAt ?? null,
    online: isOnline(a),
  });
});

export default router;
