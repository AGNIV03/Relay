import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import {
  lastfmAvailable,
  lastfmAuthUrl,
  lastfmGetSession,
  lastfmGetToken,
  listenBrainzName,
  rememberListenBrainzName,
  validateListenBrainzToken,
  ScrobbleServiceError,
} from "../services/scrobble.js";

const router = Router();
router.use(requireAuth);

/** The status object every endpoint here returns. */
async function status(userId: string) {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { listenBrainzToken: true, lastfmSessionKey: true, lastfmUsername: true },
  });
  const lb = u?.listenBrainzToken ?? null;
  return {
    listenbrainz: { connected: !!lb, username: lb ? await listenBrainzName(userId, lb) : null },
    lastfm: {
      connected: !!u?.lastfmSessionKey,
      username: u?.lastfmSessionKey ? (u.lastfmUsername ?? null) : null,
      available: lastfmAvailable(),
    },
  };
}

// Last.fm request tokens handed out by /lastfm/start, per user, so /complete
// only accepts a token this user started (in-memory; a restart means "start again").
const pendingLastfm = new Map<string, { token: string; at: number }>();
const PENDING_TTL_MS = 60 * 60_000; // Last.fm request tokens live 60 minutes

/** GET /api/scrobbling -> { listenbrainz: {connected, username}, lastfm: {connected, username, available} } */
router.get("/", async (req, res) => {
  res.json(await status(req.user!.id));
});

/** POST /api/scrobbling/listenbrainz { token } — validate + connect. */
router.post("/listenbrainz", async (req, res) => {
  const parsed = z.object({ token: z.string().trim().min(1).max(200) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid ListenBrainz token" });
  let name: string | null;
  try {
    name = await validateListenBrainzToken(parsed.data.token);
  } catch (e) {
    if (!(e instanceof ScrobbleServiceError)) throw e;
    console.warn("[scrobbling] ListenBrainz validation failed:", e.message);
    return res.status(502).json({ error: "Couldn't reach ListenBrainz. Please try again later." });
  }
  if (!name) return res.status(400).json({ error: "Invalid ListenBrainz token" });
  await prisma.user.update({
    where: { id: req.user!.id },
    data: { listenBrainzToken: parsed.data.token },
  });
  rememberListenBrainzName(req.user!.id, name);
  res.json(await status(req.user!.id));
});

/** DELETE /api/scrobbling/listenbrainz — disconnect. */
router.delete("/listenbrainz", async (req, res) => {
  await prisma.user.update({ where: { id: req.user!.id }, data: { listenBrainzToken: null } });
  rememberListenBrainzName(req.user!.id, null);
  res.json(await status(req.user!.id));
});

/** POST /api/scrobbling/lastfm/start -> { authUrl, token } — open authUrl, approve,
 *  then call /lastfm/complete with the token. */
router.post("/lastfm/start", async (req, res) => {
  if (!lastfmAvailable()) {
    return res.status(400).json({ error: "Last.fm isn't configured on this server" });
  }
  try {
    const token = await lastfmGetToken();
    const now = Date.now();
    for (const [k, v] of pendingLastfm) if (now - v.at > PENDING_TTL_MS) pendingLastfm.delete(k);
    pendingLastfm.set(req.user!.id, { token, at: now });
    res.json({ authUrl: lastfmAuthUrl(token), token });
  } catch (e) {
    if (!(e instanceof ScrobbleServiceError)) throw e;
    console.warn("[scrobbling] Last.fm start failed:", e.message);
    res.status(502).json({ error: "Couldn't reach Last.fm. Please try again later." });
  }
});

/** POST /api/scrobbling/lastfm/complete { token } — finish connecting (400 until approved). */
router.post("/lastfm/complete", async (req, res) => {
  if (!lastfmAvailable()) {
    return res.status(400).json({ error: "Last.fm isn't configured on this server" });
  }
  const parsed = z.object({ token: z.string().trim().min(1).max(200) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });
  const pending = pendingLastfm.get(req.user!.id);
  if (!pending || pending.token !== parsed.data.token || Date.now() - pending.at > PENDING_TTL_MS) {
    return res.status(400).json({ error: "This Last.fm request has expired. Please start again." });
  }
  let session: { name: string; key: string } | null;
  try {
    session = await lastfmGetSession(parsed.data.token);
  } catch (e) {
    if (!(e instanceof ScrobbleServiceError)) throw e;
    console.warn("[scrobbling] Last.fm complete failed:", e.message);
    return res.status(502).json({ error: "Couldn't reach Last.fm. Please try again later." });
  }
  if (!session) {
    return res.status(400).json({ error: "Not approved yet. Approve access on Last.fm, then try again." });
  }
  pendingLastfm.delete(req.user!.id);
  await prisma.user.update({
    where: { id: req.user!.id },
    data: { lastfmSessionKey: session.key, lastfmUsername: session.name },
  });
  res.json(await status(req.user!.id));
});

/** DELETE /api/scrobbling/lastfm — disconnect. */
router.delete("/lastfm", async (req, res) => {
  pendingLastfm.delete(req.user!.id);
  await prisma.user.update({
    where: { id: req.user!.id },
    data: { lastfmSessionKey: null, lastfmUsername: null },
  });
  res.json(await status(req.user!.id));
});

export default router;
