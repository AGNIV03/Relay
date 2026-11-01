import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import {
  setActivity,
  getActivity,
  isOnline,
  subscribeActivity,
  notifyActivity,
} from "../lib/presence.js";
import { hostMode, chorusHostOf } from "../lib/chorus.js";
import { acquirePoll, releasePoll } from "../lib/pollGuard.js";
import { canListenAlong, getPrivacy, rememberPrivacy, setPrivacy } from "../lib/privacy.js";
import { qnum } from "../lib/query.js";

const router = Router();
router.use(requireAuth);

const LONG_POLL_MS = 25_000;
// Accepted window for a client-supplied sample time (server clock): a little in
// the future for estimate error, up to 10s in the past for a slow request.
const AT_MAX_AGE_MS = 10_000;
const AT_MAX_AHEAD_MS = 1_000;

/** Build the listen-along payload for a host: their live track + position. Carries
 *  `serverNow` so followers can correct for clock skew when extrapolating. */
async function hostActivity(userId: string) {
  const a = getActivity(userId);
  const track = a?.trackId
    ? await prisma.track.findUnique({
        where: { id: a.trackId },
        include: { artist: true, album: true },
      })
    : null;
  return {
    trackId: a?.trackId ?? null,
    track,
    positionMs: a?.positionMs ?? 0,
    playing: a?.playing ?? false,
    updatedAt: a?.updatedAt ?? null,
    online: isOnline(a),
    version: a?.version ?? 0,
    serverNow: Date.now(),
  };
}

/** Why `viewerId` may not follow `hostId`'s live playback, or null if allowed. */
async function followDenied(viewerId: string, hostId: string): Promise<string | null> {
  if (viewerId === hostId) return null;
  const p = await getPrivacy(hostId);
  if (!p) return null; // unknown user — empty state, as before
  if (!p.shareActivity) return "This user isn't sharing their activity";
  if (!p.allowListenAlong) return "This user doesn't allow listen-along";
  return null;
}

/** GET /api/social/time — the server clock, for NTP-style offset/RTT estimation. */
router.get("/time", (_req, res) => {
  res.set("Cache-Control", "no-store").json({ serverNow: Date.now() });
});

/** GET /api/social/privacy — the caller's privacy flags */
router.get("/privacy", async (req, res) => {
  const p = await getPrivacy(req.user!.id);
  if (!p) return res.status(404).json({ error: "Not found" });
  res.json(p);
});

/** PATCH /api/social/privacy { shareActivity?, allowListenAlong? } */
router.patch("/privacy", async (req, res) => {
  const parsed = z
    .object({ shareActivity: z.boolean().optional(), allowListenAlong: z.boolean().optional() })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });
  const me = req.user!.id;
  const p = await setPrivacy(me, parsed.data).catch(() => null);
  if (!p) return res.status(404).json({ error: "Not found" });
  notifyActivity(me); // held listen-along polls re-check access right away
  res.json(p);
});

/** POST /api/social/activity — heartbeat with the user's current playback state.
 *  Optional `atServerMs`: the client's estimate of SERVER time when it read its
 *  position; used as the sample time (stale/out-of-order samples are dropped). */
router.post("/activity", async (req, res) => {
  const parsed = z
    .object({
      trackId: z.string().nullable().optional(),
      positionMs: z.number().int().nonnegative().optional(),
      playing: z.boolean().optional(),
      listeningTo: z.string().nullable().optional(), // host we're listening-along to
      atServerMs: z.number().finite().optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });
  const me = req.user!.id;

  // Only record a listen-along target that exists, isn't us, and allows it.
  let listeningTo = parsed.data.listeningTo ?? null;
  if (listeningTo && (listeningTo === me || !canListenAlong(await getPrivacy(listeningTo)))) {
    listeningTo = null;
  }

  const now = Date.now();
  const at = parsed.data.atServerMs;
  const sampleAt =
    at !== undefined && at >= now - AT_MAX_AGE_MS && at <= now + AT_MAX_AHEAD_MS
      ? Math.min(Math.round(at), now)
      : undefined;
  setActivity(
    me,
    {
      trackId: parsed.data.trackId ?? null,
      positionMs: parsed.data.positionMs ?? 0,
      playing: parsed.data.playing ?? false,
      listeningTo,
    },
    sampleAt,
  ); // an out-of-order sample is ignored, but still a success for the client
  res.status(204).end();
});

/** GET /api/social/friends — every other user + what they're (or were) playing.
 *  `track` is the live track when present, otherwise the user's most recently
 *  played track (from history) so offline users still show "last listened".
 *  Users who don't share activity show online status only (`private: true`). */
router.get("/friends", async (req, res) => {
  const me = req.user!.id;
  const users = await prisma.user.findMany({
    where: { id: { not: me } },
    select: { id: true, username: true, shareActivity: true, allowListenAlong: true },
  });
  for (const u of users) rememberPrivacy(u.id, u);
  const acts = users.map((u) => ({ u, a: getActivity(u.id) }));
  const shared = acts.filter((x) => x.u.shareActivity);

  // Resolve live presence tracks in one query.
  const liveIds = [...new Set(shared.map((x) => x.a?.trackId).filter((t): t is string => !!t))];
  const liveTracks = liveIds.length
    ? await prisma.track.findMany({
        where: { id: { in: liveIds } },
        include: { artist: true, album: true },
      })
    : [];
  const byId = new Map(liveTracks.map((t) => [t.id, t]));

  // Fallback "last played" for users without a live track — resolved in ONE query
  // (distinct on userId, newest first) instead of one findFirst per user.
  const needFallback = shared
    .filter((x) => !(x.a?.trackId && byId.has(x.a.trackId)))
    .map((x) => x.u.id);
  const lastByUser = new Map<string, (typeof liveTracks)[number]>();
  if (needFallback.length) {
    const hist = await prisma.playHistory.findMany({
      where: { userId: { in: needFallback } },
      orderBy: { playedAt: "desc" },
      distinct: ["userId"],
      include: { track: { include: { artist: true, album: true } } },
    });
    for (const h of hist) if (h.track) lastByUser.set(h.userId, h.track);
  }

  const myChorus = chorusHostOf(me); // the chorus I'm in, if any
  const friends = acts.map(({ u, a }) => {
    const online = isOnline(a);
    const base = {
      id: u.id,
      username: u.username,
      online,
      chorusMode: hostMode(u.id), // 'open' | 'ask' | null — they're hosting a Chorus
      // Per-viewer relationship to ME (the requester):
      inChorusWithYou: !!myChorus && chorusHostOf(u.id) === myChorus,
      allowListenAlong: u.shareActivity && u.allowListenAlong,
    };
    if (!u.shareActivity) {
      // Private: online status only — no track, playing state or timestamps.
      return { ...base, private: true, playing: false, track: null, updatedAt: null, listeningToYou: false, _sort: 0 };
    }
    // Prefer the live presence track; fall back to the last played track so
    // an offline user still shows what they were last listening to.
    const track = (a?.trackId ? byId.get(a.trackId) : undefined) ?? lastByUser.get(u.id) ?? null;
    return {
      ...base,
      private: false,
      playing: a?.playing ?? false,
      track,
      updatedAt: a?.updatedAt ?? null,
      listeningToYou: online && a?.listeningTo === me,
      _sort: a?.updatedAt ?? 0,
    };
  });
  friends.sort((x, y) => Number(y.online) - Number(x.online) || y._sort - x._sort);
  res.json(friends.map(({ _sort, ...f }) => f));
});

/** GET /api/social/users/:id — a user's public profile: details, favorite songs,
 *  and their public playlists (all of them for your own profile). Powers the
 *  "click a friend" profile popup. Favorites are withheld (`private: true`,
 *  empty list) for users who don't share their activity. */
router.get("/users/:id", async (req, res) => {
  const me = req.user!.id;
  const user = await prisma.user.findUnique({
    where: { id: req.params.id },
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
  const { shareActivity, allowListenAlong, ...details } = user;
  rememberPrivacy(user.id, { shareActivity, allowListenAlong });
  const self = user.id === me;
  const hidden = !self && !shareActivity;

  const [favorites, playlists, likeCount] = await Promise.all([
    hidden
      ? Promise.resolve([])
      : prisma.favorite.findMany({
          where: { userId: user.id },
          orderBy: { createdAt: "desc" },
          take: 50,
          include: { track: { include: { artist: true, album: true } } },
        }),
    prisma.playlist.findMany({
      where: { userId: user.id, ...(self ? {} : { isPublic: true }) },
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { tracks: true } } },
    }),
    hidden ? Promise.resolve(0) : prisma.favorite.count({ where: { userId: user.id } }),
  ]);

  res.json({
    ...details,
    private: hidden,
    allowListenAlong: shareActivity && allowListenAlong,
    likeCount,
    favorites: favorites.map((f) => f.track),
    playlists: playlists.map((p) => ({ id: p.id, name: p.name, trackCount: p._count.tracks })),
  });
});

/** GET /api/social/activity/:userId — a user's live state, for "listen along".
 *  403 when that user doesn't share activity / allow listen-along. */
router.get("/activity/:userId", async (req, res) => {
  const denied = await followDenied(req.user!.id, req.params.userId);
  if (denied) return res.status(403).json({ error: denied });
  res.json(await hostActivity(req.params.userId));
});

/** GET /api/social/activity/:userId/poll?since=<version> — long-poll: returns as
 *  soon as the host's playback changes past `since` (or after ~25s). Lets listen-
 *  along followers track pauses/seeks near-instantly instead of every few seconds.
 *  Access is checked before holding (403 immediately) and again on wake-up. */
router.get("/activity/:userId/poll", async (req, res) => {
  const me = req.user!.id;
  const hostId = req.params.userId;
  const denied = await followDenied(me, hostId);
  if (denied) return res.status(403).json({ error: denied });
  const since = qnum(req.query.since) || 0;
  const a = getActivity(hostId);
  if (!a || a.version > since) return res.json(await hostActivity(hostId));

  // Cap concurrent held polls per user; over the cap, return current state now.
  if (!acquirePoll(me)) return res.json(await hostActivity(hostId));

  let settled = false;
  const done = () => {
    if (settled) return false;
    settled = true;
    clearTimeout(timer);
    unsub();
    releasePoll(me);
    return true;
  };
  const finish = async () => {
    if (!done()) return;
    try {
      // The host may have gone private while we were holding.
      const nowDenied = await followDenied(me, hostId);
      if (nowDenied) return void res.status(403).json({ error: nowDenied });
      res.json(await hostActivity(hostId));
    } catch {
      if (!res.headersSent) res.json(await hostActivity(hostId).catch(() => null));
    }
  };
  const unsub = subscribeActivity(hostId, () => void finish());
  const timer = setTimeout(() => void finish(), LONG_POLL_MS);
  req.on("close", () => void done());
});

export default router;
