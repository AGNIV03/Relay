import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import {
  type ChorusMode,
  approve,
  deny,
  getChorusForUser,
  joinChorus,
  leaveChorus,
  removeMember,
  setMode,
  startChorus,
  updateState,
} from "../lib/chorus.js";

const router = Router();
router.use(requireAuth);

const modeSchema = z.enum(["open", "ask"]);
const stateSchema = z.object({
  queue: z.array(z.string()),
  index: z.number().int().nonnegative(),
  positionMs: z.number().int().nonnegative(),
  playing: z.boolean(),
});

/** Hydrate a chorus into a client-facing payload (track objects + usernames). */
async function hydrate(userId: string) {
  const c = getChorusForUser(userId);
  if (!c) return null;
  const userIds = [...new Set([...c.members, ...c.pending])];
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, username: true },
  });
  const nameById = new Map(users.map((u) => [u.id, u.username]));

  const trackIds = [...new Set(c.queue)];
  const tracks = trackIds.length
    ? await prisma.track.findMany({
        where: { id: { in: trackIds } },
        include: { artist: true, album: true },
      })
    : [];
  const trackById = new Map(tracks.map((t) => [t.id, t]));

  const ref = (id: string) => ({ id, username: nameById.get(id) ?? "?" });
  return {
    hostId: c.hostId,
    hostName: nameById.get(c.hostId) ?? "?",
    mode: c.mode,
    isHost: c.hostId === userId,
    members: [...c.members].map(ref),
    pending: [...c.pending].map(ref),
    queue: c.queue.map((id) => trackById.get(id)).filter(Boolean),
    queueIds: c.queue,
    index: c.index,
    positionMs: c.positionMs,
    playing: c.playing,
    updatedAt: c.updatedAt,
    controllerId: c.controllerId,
    controllerName: nameById.get(c.controllerId) ?? "?",
  };
}

/** GET /api/chorus — the chorus the caller is in (host or member), hydrated. */
router.get("/", async (req, res) => {
  res.json(await hydrate(req.user!.id));
});

/** POST /api/chorus/start { mode, queue, index, positionMs, playing } */
router.post("/start", async (req, res) => {
  const parsed = z
    .object({ mode: modeSchema })
    .and(stateSchema)
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });
  const { mode, queue, index, positionMs, playing } = parsed.data;
  startChorus(req.user!.id, mode as ChorusMode, queue, index, positionMs, playing);
  res.json(await hydrate(req.user!.id));
});

/** POST /api/chorus/stop — host ends the chorus (or a member leaves). */
router.post("/stop", (req, res) => {
  leaveChorus(req.user!.id);
  res.status(204).end();
});

/** POST /api/chorus/leave — leave the chorus I'm in. */
router.post("/leave", (req, res) => {
  leaveChorus(req.user!.id);
  res.status(204).end();
});

/** POST /api/chorus/mode { mode } — host toggles open / ask-to-join. */
router.post("/mode", (req, res) => {
  const parsed = z.object({ mode: modeSchema }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });
  setMode(req.user!.id, parsed.data.mode as ChorusMode);
  res.status(204).end();
});

/** POST /api/chorus/join { hostId } — join (open) or request (ask). */
router.post("/join", (req, res) => {
  const parsed = z.object({ hostId: z.string() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });
  const result = joinChorus(req.user!.id, parsed.data.hostId);
  if (result === "notfound") return res.status(404).json({ error: "Chorus not found" });
  res.json({ status: result });
});

/** POST /api/chorus/approve { userId } — host approves a pending request. */
router.post("/approve", (req, res) => {
  const parsed = z.object({ userId: z.string() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });
  approve(req.user!.id, parsed.data.userId);
  res.status(204).end();
});

/** POST /api/chorus/deny { userId } — host denies a pending request. */
router.post("/deny", (req, res) => {
  const parsed = z.object({ userId: z.string() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });
  deny(req.user!.id, parsed.data.userId);
  res.status(204).end();
});

/** POST /api/chorus/remove { userId } — host removes a member. */
router.post("/remove", (req, res) => {
  const parsed = z.object({ userId: z.string() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });
  // Only the host may remove others (a chorus is keyed by host id).
  removeMember(req.user!.id, parsed.data.userId);
  res.status(204).end();
});

/** POST /api/chorus/state { queue, index, positionMs, playing } — any member
 *  updates the shared playback (change song / queue / play-pause / seek). */
router.post("/state", (req, res) => {
  const parsed = stateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });
  const ok = updateState(req.user!.id, parsed.data);
  if (!ok) return res.status(409).json({ error: "Not in a chorus" });
  res.status(204).end();
});

export default router;
