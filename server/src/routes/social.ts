import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { setActivity, getActivity, isOnline, subscribeActivity } from "../lib/presence.js";
import { hostMode } from "../lib/chorus.js";

const router = Router();
router.use(requireAuth);

const LONG_POLL_MS = 25_000;

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

/** GET /api/social/friends — every other user + what they're (or were) playing.
 *  `track` is the live track when present, otherwise the user's most recently
 *  played track (from history) so offline users still show "last listened". */
router.get("/friends", async (req, res) => {
  const me = req.user!.id;
  const users = await prisma.user.findMany({
    where: { id: { not: me } },
    select: { id: true, username: true },
  });
  const acts = users.map((u) => ({ u, a: getActivity(u.id) }));

  // Resolve live presence tracks in one query.
  const liveIds = [...new Set(acts.map((x) => x.a?.trackId).filter((t): t is string => !!t))];
  const liveTracks = liveIds.length
    ? await prisma.track.findMany({
        where: { id: { in: liveIds } },
        include: { artist: true, album: true },
      })
    : [];
  const byId = new Map(liveTracks.map((t) => [t.id, t]));

  const friends = await Promise.all(
    acts.map(async ({ u, a }) => {
      // Prefer the live presence track; fall back to the last played track so
      // an offline user still shows what they were last listening to.
      let track = a?.trackId ? byId.get(a.trackId) ?? null : null;
      if (!track) {
        const last = await prisma.playHistory.findFirst({
          where: { userId: u.id },
          orderBy: { playedAt: "desc" },
          include: { track: { include: { artist: true, album: true } } },
        });
        track = last?.track ?? null;
      }
      return {
        id: u.id,
        username: u.username,
        online: isOnline(a),
        playing: a?.playing ?? false,
        track,
        updatedAt: a?.updatedAt ?? null,
        chorusMode: hostMode(u.id), // 'open' | 'ask' | null — they're hosting a Chorus
      };
    }),
  );
  friends.sort(
    (x, y) => Number(y.online) - Number(x.online) || (y.updatedAt ?? 0) - (x.updatedAt ?? 0),
  );
  res.json(friends);
});

/** GET /api/social/users/:id — a user's public profile: details, favorite songs,
 *  and their (owned) playlists. Powers the "click a friend" profile popup. */
router.get("/users/:id", async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.params.id },
    select: { id: true, username: true, role: true, createdAt: true },
  });
  if (!user) return res.status(404).json({ error: "Not found" });

  const [favorites, playlists, likeCount] = await Promise.all([
    prisma.favorite.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { track: { include: { artist: true, album: true } } },
    }),
    prisma.playlist.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { tracks: true } } },
    }),
    prisma.favorite.count({ where: { userId: user.id } }),
  ]);

  res.json({
    ...user,
    likeCount,
    favorites: favorites.map((f) => f.track),
    playlists: playlists.map((p) => ({ id: p.id, name: p.name, trackCount: p._count.tracks })),
  });
});

/** GET /api/social/activity/:userId — a user's live state, for "listen along". */
router.get("/activity/:userId", async (req, res) => {
  res.json(await hostActivity(req.params.userId));
});

/** GET /api/social/activity/:userId/poll?since=<version> — long-poll: returns as
 *  soon as the host's playback changes past `since` (or after ~25s). Lets listen-
 *  along followers track pauses/seeks near-instantly instead of every few seconds. */
router.get("/activity/:userId/poll", async (req, res) => {
  const hostId = req.params.userId;
  const since = Number(req.query.since ?? 0) || 0;
  const a = getActivity(hostId);
  if (!a || a.version > since) return res.json(await hostActivity(hostId));

  let settled = false;
  const finish = async () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    unsub();
    try {
      res.json(await hostActivity(hostId));
    } catch {
      if (!res.headersSent) res.json(await hostActivity(hostId).catch(() => null));
    }
  };
  const unsub = subscribeActivity(hostId, () => void finish());
  const timer = setTimeout(() => void finish(), LONG_POLL_MS);
  req.on("close", () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    unsub();
  });
});

export default router;
