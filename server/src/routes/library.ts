import { Router } from "express";
import { z } from "zod";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import {
  deleteAlbumIfEmpty,
  fetchAndStoreLyrics,
  findOrCreateAlbum,
  findOrCreateArtist,
  ingestFile,
  IngestRejectedError,
  translateAndStore,
} from "../services/scanner.js";
import { looksLikeAudio } from "../services/audioCheck.js";
import { queueAutotag } from "../services/autotag.js";
import { queueLoudness } from "../services/loudness.js";
import { recordRejection } from "../services/ingestLog.js";
import { forwardNowPlaying, forwardScrobble } from "../services/scrobble.js";
import { env } from "../lib/env.js";
import { rankTracks } from "../lib/search.js";
import { qnum, qstr } from "../lib/query.js";

const router = Router();
router.use(requireAuth);

// Uploadable audio formats — all play natively on web, Android (ExoPlayer) and
// desktop (media_kit). WMA/AIFF are deliberately excluded (poor web/Android support).
const UPLOAD_EXT = new Set([".mp3", ".flac", ".m4a", ".aac", ".ogg", ".opus", ".wav"]);

// Uploads are written verbatim to the music library — NO transcoding, so original
// quality (incl. lossless) is preserved byte-for-byte. Any signed-in user may
// upload; the track becomes visible to everyone (this is a sharing app).
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
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = UPLOAD_EXT.has(path.extname(file.originalname).toLowerCase());
    if (!ok) recordRejection(file.originalname, "Unsupported file type", "upload", req.user?.id);
    cb(null, ok);
  },
});

/** GET /api/library/artists */
router.get("/artists", async (_req, res) => {
  const artists = await prisma.artist.findMany({
    orderBy: { name: "asc" },
    include: { _count: { select: { albums: true, tracks: true } } },
  });
  res.json(artists);
});

/** GET /api/library/artists/:id */
router.get("/artists/:id", async (req, res) => {
  const artist = await prisma.artist.findUnique({
    where: { id: req.params.id },
    include: {
      albums: { orderBy: { year: "asc" }, include: { _count: { select: { tracks: true } } } },
    },
  });
  if (!artist) return res.status(404).json({ error: "Not found" });
  res.json(artist);
});

/** GET /api/library/albums?recent=1 */
router.get("/albums", async (req, res) => {
  const recent = qstr(req.query.recent) === "1";
  const albums = await prisma.album.findMany({
    orderBy: recent ? { createdAt: "desc" } : { title: "asc" },
    take: recent ? 50 : undefined,
    include: { artist: true, _count: { select: { tracks: true } } },
  });
  res.json(albums);
});

/** GET /api/library/albums/:id */
router.get("/albums/:id", async (req, res) => {
  const album = await prisma.album.findUnique({
    where: { id: req.params.id },
    include: {
      artist: true,
      tracks: {
        orderBy: [{ discNo: "asc" }, { trackNo: "asc" }, { title: "asc" }],
        include: { artist: true },
      },
    },
  });
  if (!album) return res.status(404).json({ error: "Not found" });
  res.json(album);
});

/** GET /api/library/tracks?limit=&offset=&q= — flat list, optional search across title/artist/album */
router.get("/tracks", async (req, res) => {
  const limit = Math.min(Math.max(qnum(req.query.limit) || 100, 1), 1000);
  const offset = Math.max(qnum(req.query.offset) || 0, 0);
  const q = qstr(req.query.q)?.trim();
  const contains = q ? { contains: q, mode: "insensitive" as const } : undefined;
  const where = contains
    ? {
        OR: [
          { title: contains },
          { artist: { name: contains } },
          { album: { title: contains } },
        ],
      }
    : {};

  // No query → the plain alphabetical, DB-paginated list (unchanged).
  if (!q) {
    const [tracks, total] = await Promise.all([
      prisma.track.findMany({
        where,
        orderBy: { title: "asc" },
        skip: offset,
        take: limit,
        include: { artist: true, album: true, uploader: { select: { username: true } } },
      }),
      prisma.track.count({ where }),
    ]);
    return res.json({ tracks, total, limit, offset });
  }

  // Query → rank by relevance (word-start beats mid-word substring) BEFORE
  // paginating, so the best matches lead. Ranking is in-memory, so bound the
  // candidate set; a personal library's match count for any real query is small.
  const candidates = await prisma.track.findMany({
    where,
    orderBy: { title: "asc" },
    take: 1000,
    include: { artist: true, album: true, uploader: { select: { username: true } } },
  });
  const ranked = rankTracks(candidates, q);
  const tracks = ranked.slice(offset, offset + limit);
  res.json({ tracks, total: ranked.length, limit, offset });
});

/** GET /api/library/tracks/by-ids?ids=a,b,c — hydrate specific tracks, preserving
 *  the requested order. Used by a Chorus host to resolve member-proposed queues. */
router.get("/tracks/by-ids", async (req, res) => {
  // `?ids=a,b` or repeated `?ids=a&ids=b` — both accepted.
  const ids = [req.query.ids]
    .flat()
    .filter((s): s is string => typeof s === "string")
    .join(",")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 1000);
  if (ids.length === 0) return res.json({ tracks: [] });
  const found = await prisma.track.findMany({
    where: { id: { in: ids } },
    include: { artist: true, album: true, uploader: { select: { username: true } } },
  });
  const byId = new Map(found.map((t) => [t.id, t]));
  const tracks = ids.map((id) => byId.get(id)).filter(Boolean);
  res.json({ tracks });
});

/** POST /api/library/scrobble { trackId } — record a play (drives stats + recently/most played) */
router.post("/scrobble", async (req, res) => {
  const parsed = z
    .object({ trackId: z.string(), playlistId: z.string().optional() })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });
  // playlistId records the playback context so Recently Played can show the
  // playlist instead of its individual tracks. Only kept if it exists AND the
  // caller can see it (public, owned, or a collaborator) — otherwise ignored.
  const me = req.user!.id;
  let playlistId: string | null = parsed.data.playlistId ?? null;
  if (playlistId) {
    const visible = await prisma.playlist.count({
      where: {
        id: playlistId,
        OR: [{ isPublic: true }, { userId: me }, { collaborators: { some: { userId: me } } }],
      },
    });
    if (!visible) playlistId = null;
  }
  await prisma.playHistory.create({
    data: { userId: req.user!.id, trackId: parsed.data.trackId, playlistId },
  });
  res.status(204).end();
  forwardNowPlaying(me, parsed.data.trackId); // ListenBrainz / Last.fm, if connected
});

/** POST /api/library/scrobble/complete { trackId, startedAt (ISO) } — a finished
 *  listen (played >= 50% or >= 4 min, client-side rule). Forwarded as a scrobble
 *  to the user's connected ListenBrainz / Last.fm accounts. The play itself was
 *  already recorded by /scrobble. */
router.post("/scrobble/complete", async (req, res) => {
  const parsed = z
    .object({ trackId: z.string().min(1).max(64), startedAt: z.string().min(1).max(64) })
    .safeParse(req.body);
  const startedAt = parsed.success ? new Date(parsed.data.startedAt) : null;
  if (!parsed.success || !startedAt || !Number.isFinite(startedAt.getTime())) {
    return res.status(400).json({ error: "Invalid input" });
  }
  res.status(204).end();
  // Services reject listens from the future or older than two weeks.
  const now = Date.now();
  const t = startedAt.getTime();
  if (t > now + 5 * 60_000 || t < now - 14 * 24 * 60 * 60_000) return;
  forwardScrobble(req.user!.id, parsed.data.trackId, startedAt);
});

/** GET /api/library/radio?seed=<trackId>&exclude=<csv ids>&limit=<1..50, default 20>
 *  -> Track[] (artist + album). Autoplay / radio: tracks by the seed's artist,
 *  the same genre, the user's frequently played tracks, then random fill.
 *  Never returns excluded ids (or the seed); shuffled. */
router.get("/radio", async (req, res) => {
  const limit = Math.min(Math.max(Math.floor(qnum(req.query.limit)) || 20, 1), 50);
  const seedId = qstr(req.query.seed)?.trim() || null;
  const exclude = new Set(
    [req.query.exclude]
      .flat()
      .filter((s): s is string => typeof s === "string")
      .join(",")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 2000),
  );
  if (seedId) exclude.add(seedId);

  const seed = seedId
    ? await prisma.track.findUnique({
        where: { id: seedId },
        select: { artistId: true, genre: true },
      })
    : null;

  const picked: string[] = [];
  const take = (ids: string[], n: number) => {
    for (const id of shuffle(ids)) {
      if (n <= 0 || picked.length >= limit) break;
      if (exclude.has(id)) continue;
      exclude.add(id);
      picked.push(id);
      n--;
    }
  };

  if (seed) {
    const sameArtist = await prisma.track.findMany({
      where: { artistId: seed.artistId },
      select: { id: true },
      take: 500,
    });
    take(sameArtist.map((t) => t.id), Math.ceil(limit * 0.35));
    if (seed.genre) {
      const sameGenre = await prisma.track.findMany({
        where: { genre: { equals: seed.genre, mode: "insensitive" }, artistId: { not: seed.artistId } },
        select: { id: true },
        take: 1000,
      });
      take(sameGenre.map((t) => t.id), Math.ceil(limit * 0.35));
    }
  }
  const frequent = await prisma.playHistory.groupBy({
    by: ["trackId"],
    where: { userId: req.user!.id },
    _count: { trackId: true },
    orderBy: { _count: { trackId: "desc" } },
    take: 100,
  });
  take(frequent.map((f) => f.trackId), Math.ceil(limit * 0.25));

  if (picked.length < limit) {
    const random = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Track"
      WHERE NOT (id = ANY(${[...exclude]}::text[]))
      ORDER BY random()
      LIMIT ${limit - picked.length}::int`;
    take(random.map((r) => r.id), limit - picked.length);
  }

  const tracks = await prisma.track.findMany({
    where: { id: { in: picked } },
    include: { artist: true, album: true },
  });
  res.json(shuffle(tracks));
});

/** Fisher-Yates shuffle (returns a new array). */
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** GET /api/library/recently-played — most-recent-first mix of tracks and
 *  playlists. A track played from a playlist collapses into that playlist entry
 *  (deduped) instead of showing the individual songs; standalone plays show the
 *  track. Items: {type:'track', track} | {type:'playlist', playlist}. */
router.get("/recently-played", async (req, res) => {
  const limit = Math.min(Math.max(qnum(req.query.limit) || 12, 1), 50);
  // Legacy shape (Track[]) for older app builds that don't pass ?grouped=1.
  if (qstr(req.query.grouped) !== "1") {
    const groups = await prisma.playHistory.groupBy({
      by: ["trackId"],
      where: { userId: req.user!.id },
      _max: { playedAt: true },
      orderBy: { _max: { playedAt: "desc" } },
      take: limit,
    });
    const tracks = await prisma.track.findMany({
      where: { id: { in: groups.map((g) => g.trackId) } },
      include: { artist: true, album: true },
    });
    const byId = new Map(tracks.map((t) => [t.id, t]));
    return res.json(groups.map((g) => byId.get(g.trackId)).filter(Boolean));
  }
  const rows = await prisma.playHistory.findMany({
    where: { userId: req.user!.id },
    orderBy: { playedAt: "desc" },
    select: { trackId: true, playlistId: true },
    take: 500,
  });
  const seenTracks = new Set<string>();
  const seenPlaylists = new Set<string>();
  const order: Array<{ kind: "track" | "playlist"; id: string }> = [];
  for (const r of rows) {
    if (order.length >= limit) break;
    if (r.playlistId) {
      if (seenPlaylists.has(r.playlistId)) continue;
      seenPlaylists.add(r.playlistId);
      order.push({ kind: "playlist", id: r.playlistId });
    } else {
      if (seenTracks.has(r.trackId)) continue;
      seenTracks.add(r.trackId);
      order.push({ kind: "track", id: r.trackId });
    }
  }
  const [tracks, playlists] = await Promise.all([
    prisma.track.findMany({
      where: { id: { in: order.filter((o) => o.kind === "track").map((o) => o.id) } },
      include: { artist: true, album: true },
    }),
    prisma.playlist.findMany({
      where: { id: { in: order.filter((o) => o.kind === "playlist").map((o) => o.id) } },
      include: { _count: { select: { tracks: true } }, user: { select: { username: true } } },
    }),
  ]);
  const tById = new Map(tracks.map((t) => [t.id, t]));
  const pById = new Map(playlists.map((p) => [p.id, p]));
  const items = order
    .map((o) => {
      if (o.kind === "track") {
        const t = tById.get(o.id);
        return t ? { type: "track" as const, track: t } : null;
      }
      const p = pById.get(o.id);
      return p
        ? {
            type: "playlist" as const,
            playlist: {
              id: p.id,
              name: p.name,
              coverPath: p.coverPath,
              ownerName: p.user.username,
              trackCount: p._count.tracks,
            },
          }
        : null;
    })
    .filter(Boolean);
  res.json(items);
});

/** GET /api/library/most-played — top tracks by play count */
router.get("/most-played", async (req, res) => {
  const limit = Math.min(Math.max(qnum(req.query.limit) || 12, 1), 50);
  const groups = await prisma.playHistory.groupBy({
    by: ["trackId"],
    where: { userId: req.user!.id },
    _count: { trackId: true },
    orderBy: { _count: { trackId: "desc" } },
    take: limit,
  });
  const tracks = await prisma.track.findMany({
    where: { id: { in: groups.map((g) => g.trackId) } },
    include: { artist: true, album: true },
  });
  const byId = new Map(tracks.map((t) => [t.id, t]));
  res.json(
    groups
      .map((g) => {
        const t = byId.get(g.trackId);
        return t ? { ...t, playCount: g._count.trackId } : null;
      })
      .filter(Boolean),
  );
});

/** GET /api/library/stats/me — personal "wrapped"-style listening summary */
router.get("/stats/me", async (req, res) => {
  const userId = req.user!.id;
  const grouped = await prisma.playHistory.groupBy({
    by: ["trackId"],
    where: { userId },
    _count: { trackId: true },
  });
  const tracks = await prisma.track.findMany({
    where: { id: { in: grouped.map((g) => g.trackId) } },
    include: { artist: true },
  });
  const byId = new Map(tracks.map((t) => [t.id, t]));

  let totalPlays = 0;
  let totalSeconds = 0;
  const artistCounts = new Map<string, number>();
  const genreCounts = new Map<string, number>();
  for (const g of grouped) {
    const t = byId.get(g.trackId);
    if (!t) continue;
    const c = g._count.trackId;
    totalPlays += c;
    totalSeconds += c * (t.duration || 0);
    const an = t.artist?.name;
    if (an) artistCounts.set(an, (artistCounts.get(an) ?? 0) + c);
    if (t.genre) genreCounts.set(t.genre, (genreCounts.get(t.genre) ?? 0) + c);
  }
  const top = (m: Map<string, number>, n: number) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, count]) => ({ name, count }));

  const topTracks = grouped
    .map((g) => ({ t: byId.get(g.trackId), c: g._count.trackId }))
    .filter((x) => x.t)
    .sort((a, b) => b.c - a.c)
    .slice(0, 5)
    .map((x) => ({ id: x.t!.id, title: x.t!.title, artist: x.t!.artist?.name ?? "", playCount: x.c }));

  res.json({
    totalPlays,
    totalMinutes: Math.round(totalSeconds / 60),
    distinctTracks: grouped.length,
    topArtists: top(artistCounts, 5),
    topGenres: top(genreCounts, 5),
    topTracks,
  });
});

/** GET /api/library/stats/wrapped?year=YYYY — year-scoped "Rewind" (Spotify
 *  Wrapped-style) listening summary for the signed-in user. Defaults to the
 *  current year. `hasData` is false when there are no plays that year. */
router.get("/stats/wrapped", async (req, res) => {
  const userId = req.user!.id;
  const nowYear = new Date().getUTCFullYear();
  const year = Math.min(Math.max(qnum(req.query.year) || nowYear, 2000), 3000);
  const start = new Date(Date.UTC(year, 0, 1));
  const end = new Date(Date.UTC(year + 1, 0, 1));

  const rows = await prisma.playHistory.findMany({
    where: { userId, playedAt: { gte: start, lt: end } },
    select: { trackId: true, playedAt: true },
  });

  const trackCounts = new Map<string, number>();
  for (const r of rows) trackCounts.set(r.trackId, (trackCounts.get(r.trackId) ?? 0) + 1);

  const tracks = await prisma.track.findMany({
    where: { id: { in: [...trackCounts.keys()] } },
    include: { artist: true },
  });
  const byId = new Map(tracks.map((t) => [t.id, t]));

  let totalPlays = 0;
  let totalSeconds = 0;
  const artistCounts = new Map<string, number>();
  const genreCounts = new Map<string, number>();
  const monthSeconds = new Array(12).fill(0);
  // Per-group play counts per track, so each top artist / genre / the peak month
  // can name its most-played track (the Rewind plays it + shows its cover).
  const artistTracks = new Map<string, Map<string, number>>();
  const genreTracks = new Map<string, Map<string, number>>();
  const monthTracks: Map<string, number>[] = Array.from({ length: 12 }, () => new Map());
  const bump = (outer: Map<string, Map<string, number>>, key: string, id: string) => {
    const inner = outer.get(key) ?? new Map<string, number>();
    inner.set(id, (inner.get(id) ?? 0) + 1);
    outer.set(key, inner);
  };
  for (const r of rows) {
    const t = byId.get(r.trackId);
    if (!t) continue;
    totalPlays += 1;
    totalSeconds += t.duration || 0;
    const month = new Date(r.playedAt).getUTCMonth();
    monthSeconds[month] += t.duration || 0;
    monthTracks[month].set(t.id, (monthTracks[month].get(t.id) ?? 0) + 1);
    const an = t.artist?.name;
    if (an) {
      artistCounts.set(an, (artistCounts.get(an) ?? 0) + 1);
      bump(artistTracks, an, t.id);
    }
    if (t.genre) {
      genreCounts.set(t.genre, (genreCounts.get(t.genre) ?? 0) + 1);
      bump(genreTracks, t.genre, t.id);
    }
  }
  const topOf = (m: Map<string, number> | undefined): string | null => {
    if (!m || m.size === 0) return null;
    return [...m.entries()].sort((a, b) => b[1] - a[1])[0][0];
  };
  const top = (m: Map<string, number>, n: number, tracksBy: Map<string, Map<string, number>>) =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([name, count]) => ({ name, count, trackId: topOf(tracksBy.get(name)) }));

  const topTracks = [...trackCounts.entries()]
    .map(([id, c]) => ({ t: byId.get(id), c }))
    .filter((x) => x.t)
    .sort((a, b) => b.c - a.c)
    .slice(0, 5)
    .map((x) => ({ id: x.t!.id, title: x.t!.title, artist: x.t!.artist?.name ?? "", playCount: x.c }));

  const monthMinutes = monthSeconds.map((s) => Math.round(s / 60));
  let peakMonth = 0;
  for (let i = 1; i < 12; i++) if (monthMinutes[i] > monthMinutes[peakMonth]) peakMonth = i;

  res.json({
    year,
    hasData: totalPlays > 0,
    totalPlays,
    totalMinutes: Math.round(totalSeconds / 60),
    distinctTracks: trackCounts.size,
    distinctArtists: artistCounts.size,
    topTracks,
    topArtists: top(artistCounts, 5, artistTracks),
    topGenres: top(genreCounts, 5, genreTracks),
    monthMinutes,
    peakMonth,
    peakMonthTrackId: topOf(monthTracks[peakMonth]),
  });
});

/** GET /api/library/tracks/:id/lyrics — synced (LRC) + plain + line-aligned English
 *  translation; fetches/translates on demand if not yet done. */
router.get("/tracks/:id/lyrics", async (req, res) => {
  let track = await prisma.track.findUnique({ where: { id: req.params.id } });
  if (!track) return res.status(404).json({ error: "Not found" });
  if (!track.lyricsChecked || !track.lyricsTransChecked) {
    await fetchAndStoreLyrics(track.id).catch(() => {});
    track = await prisma.track.findUnique({ where: { id: req.params.id } });
  }
  res.json({
    synced: track?.lyricsSynced ?? null,
    plain: track?.lyricsPlain ?? null,
    translated: track?.lyricsTranslated ?? null,
    lang: track?.lyricsLang ?? null,
  });
});

/** GET /api/library/tracks/:id/lyrics/translation — English MT of the lyrics */
router.get("/tracks/:id/lyrics/translation", async (req, res) => {
  let track = await prisma.track.findUnique({ where: { id: req.params.id } });
  if (!track) return res.status(404).json({ error: "Not found" });
  // Make sure lyrics have been fetched first (translation needs a source).
  if (!track.lyricsChecked) {
    await fetchAndStoreLyrics(track.id).catch(() => {});
    track = await prisma.track.findUnique({ where: { id: req.params.id } });
  }
  if (track && !track.lyricsTransChecked) {
    await translateAndStore(track.id).catch(() => {});
    track = await prisma.track.findUnique({ where: { id: req.params.id } });
  }
  res.json({ lang: track?.lyricsLang ?? null, translated: track?.lyricsTranslated ?? null });
});

/** Permanently delete a track: removes the DB row (cascades likes / playlist
 *  entries / play history) and the underlying audio file, then cleans up an
 *  album/artist left empty. Caller must have already authorized the deletion. */
async function removeTrackRecord(track: {
  id: string;
  albumId: string | null;
  artistId: string;
  path: string;
}) {
  // Remove the DB row first (FK cascades clear favorites/playlist entries/history).
  await prisma.track.delete({ where: { id: track.id } });

  // Delete the actual file from disk so storage is reclaimed.
  try {
    if (track.path) fs.rmSync(track.path, { force: true });
  } catch (e) {
    console.error(`[delete] could not remove file ${track.path}:`, (e as Error).message);
  }

  // Clean up an album left with no tracks (plus its cover-art file, whose
  // stored path is relative to DATA_PATH).
  if (track.albumId) await deleteAlbumIfEmpty(track.albumId);
  // Clean up an artist left with no tracks and no albums.
  const tracksLeft = await prisma.track.count({ where: { artistId: track.artistId } });
  const albumsLeft = await prisma.album.count({ where: { artistId: track.artistId } });
  if (tracksLeft === 0 && albumsLeft === 0) {
    await prisma.artist.delete({ where: { id: track.artistId } }).catch(() => {});
  }
}

/** DELETE /api/library/tracks/:id — permanently delete a track. Allowed for an
 *  ADMIN or the user who uploaded it. */
router.delete("/tracks/:id", async (req, res) => {
  const track = await prisma.track.findUnique({
    where: { id: req.params.id },
    omit: { path: false },
  });
  if (!track) return res.status(404).json({ error: "Not found" });
  const isAdmin = req.user!.role === "ADMIN";
  if (!isAdmin && track.uploaderId !== req.user!.id) {
    return res.status(403).json({ error: "You can only delete songs you uploaded" });
  }
  await removeTrackRecord(track);
  res.status(204).end();
});

const trackMetaSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  artist: z.string().trim().min(1).max(300).optional(),
  album: z.string().trim().max(300).optional(),
  year: z.number().int().min(0).max(3000).nullable().optional(),
  genre: z.string().trim().max(100).optional(),
  trackNo: z.number().int().min(1).max(999).nullable().optional(),
  discNo: z.number().int().min(1).max(99).nullable().optional(),
});

/** PATCH /api/library/tracks/:id { title?, artist?, album?, year?, genre?, trackNo?, discNo? }
 *  Edit a track's metadata (DB only — the audio file is never touched). Allowed
 *  for an ADMIN or the track's uploader. Artist/album changes re-link the track
 *  (find-or-create, same keying as ingest) and tidy up rows left empty. */
router.patch("/tracks/:id", async (req, res) => {
  const parsed = trackMetaSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });
  const body = parsed.data;

  const t = await prisma.track.findUnique({
    where: { id: req.params.id },
    include: { artist: true, album: true },
  });
  if (!t) return res.status(404).json({ error: "Not found" });
  const isAdmin = req.user!.role === "ADMIN";
  if (!isAdmin && t.uploaderId !== req.user!.id) {
    return res.status(403).json({ error: "You can only edit songs you uploaded" });
  }

  // Artist: exact-name find-or-create (same as ingest).
  const artistId =
    body.artist !== undefined && body.artist !== t.artist.name
      ? await findOrCreateArtist(body.artist)
      : t.artistId;

  // Album: keyed by (title, artist). An explicit title wins; otherwise a moved
  // artist takes the current album title along with it.
  let albumId = t.albumId;
  const albumTitle =
    body.album !== undefined ? body.album || "Unknown Album" : (t.album?.title ?? null);
  if (albumTitle !== null && (albumTitle !== t.album?.title || artistId !== t.artistId)) {
    albumId = await findOrCreateAlbum(
      albumTitle,
      artistId,
      body.year ?? t.album?.year ?? undefined,
    );
  }
  if (albumId && albumId !== t.albumId && t.album?.coverPath) {
    await inheritCover(albumId, t.album.coverPath);
  }
  // Year is an album property: apply it to whichever album the track ends up on.
  if (albumId && body.year !== undefined) {
    await prisma.album.update({ where: { id: albumId }, data: { year: body.year } });
  }

  const title = body.title ?? t.title;
  const retagged = title !== t.title || artistId !== t.artistId;
  await prisma.track.update({
    where: { id: t.id },
    data: {
      title,
      artistId,
      albumId,
      ...(body.genre !== undefined ? { genre: body.genre || null } : {}),
      ...(body.trackNo !== undefined ? { trackNo: body.trackNo } : {}),
      ...(body.discNo !== undefined ? { discNo: body.discNo } : {}),
      // Lyrics were looked up under the old title/artist — redo them.
      ...(retagged
        ? {
            lyricsChecked: false,
            lyricsTransChecked: false,
            lyricsPlain: null,
            lyricsSynced: null,
            lyricsTranslated: null,
            lyricsLang: null,
          }
        : {}),
    },
  });

  // Tidy up rows the re-link may have emptied.
  if (t.albumId && albumId !== t.albumId) await deleteAlbumIfEmpty(t.albumId);
  if (artistId !== t.artistId) {
    const [tracksLeft, albumsLeft] = await Promise.all([
      prisma.track.count({ where: { artistId: t.artistId } }),
      prisma.album.count({ where: { artistId: t.artistId } }),
    ]);
    if (tracksLeft === 0 && albumsLeft === 0) {
      await prisma.artist.delete({ where: { id: t.artistId } }).catch(() => {});
    }
  }

  if (retagged) void fetchAndStoreLyrics(t.id).catch(() => {}); // fire-and-forget

  const updated = await prisma.track.findUnique({
    where: { id: t.id },
    include: { artist: true, album: true, uploader: { select: { username: true } } },
  });
  res.json(updated);
});

/** Give a newly-linked album the old album's cover if it has none (copied, since
 *  cover files are named per album). Best-effort. */
async function inheritCover(albumId: string, oldRel: string) {
  try {
    const album = await prisma.album.findUnique({ where: { id: albumId } });
    if (!album || album.coverPath) return;
    const rel = path.join("covers", `${albumId}${path.extname(oldRel) || ".jpg"}`);
    await fs.promises.copyFile(path.resolve(env.dataPath, oldRel), path.join(env.dataPath, rel));
    await prisma.album.update({ where: { id: albumId }, data: { coverPath: rel } });
  } catch {
    /* no cover is fine */
  }
}

/** POST /api/library/tracks/bulk-delete { ids } — delete many tracks at once.
 *  Each must be admin-owned or uploaded by the caller; others are skipped and
 *  counted in `forbidden`. */
router.post("/tracks/bulk-delete", async (req, res) => {
  const parsed = z.object({ ids: z.array(z.string()).min(1).max(2000) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });
  const isAdmin = req.user!.role === "ADMIN";
  let deleted = 0;
  let forbidden = 0;
  for (const id of parsed.data.ids) {
    const track = await prisma.track.findUnique({ where: { id }, omit: { path: false } });
    if (!track) continue;
    if (!isAdmin && track.uploaderId !== req.user!.id) {
      forbidden++;
      continue;
    }
    await removeTrackRecord(track);
    deleted++;
  }
  res.json({ deleted, forbidden });
});

// ---- Likes / "Liked Songs" ------------------------------------------------

/** GET /api/library/liked — the user's liked tracks (newest first), playlist-shaped */
router.get("/liked", async (req, res) => {
  const favs = await prisma.favorite.findMany({
    where: { userId: req.user!.id },
    orderBy: { createdAt: "desc" },
    include: { track: { include: { artist: true, album: true } } },
  });
  res.json({
    id: "liked",
    name: "Liked Songs",
    system: true,
    tracks: favs.map((f, i) => ({ id: f.id, position: i, addedAt: f.createdAt, track: f.track })),
  });
});

/** GET /api/library/liked/ids — set of liked track ids, for cheap client-side state */
router.get("/liked/ids", async (req, res) => {
  const favs = await prisma.favorite.findMany({
    where: { userId: req.user!.id },
    select: { trackId: true },
  });
  res.json(favs.map((f) => f.trackId));
});

/** POST /api/library/like { trackId } — like a track (idempotent) */
router.post("/like", async (req, res) => {
  const parsed = z.object({ trackId: z.string() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });
  await prisma.favorite
    .upsert({
      where: { userId_trackId: { userId: req.user!.id, trackId: parsed.data.trackId } },
      create: { userId: req.user!.id, trackId: parsed.data.trackId },
      update: {},
    })
    .catch(() => {});
  res.status(204).end();
});

/** DELETE /api/library/like/:trackId — unlike a track */
router.delete("/like/:trackId", async (req, res) => {
  await prisma.favorite.deleteMany({
    where: { userId: req.user!.id, trackId: req.params.trackId },
  });
  res.status(204).end();
});

// ---- Uploads (any signed-in user) -----------------------------------------

type UploadStatus = "added" | "duplicate" | "failed";
/** `reason` is set when a file was refused for a user-explainable cause. */
type UploadOutcome = { status: UploadStatus; reason?: string };

/** Validate + ingest one already-saved upload file; auto-likes it for the
 *  uploader. Deletes the file on rejection or duplicate. Shared by the multipart
 *  and chunked upload paths. */
async function processUploadedFile(
  filePath: string,
  uploaderId: string,
  displayName = path.basename(filePath),
): Promise<UploadOutcome> {
  const like = (trackId: string) =>
    prisma.favorite
      .upsert({
        where: { userId_trackId: { userId: uploaderId, trackId } },
        create: { userId: uploaderId, trackId },
        update: {},
      })
      .catch(() => {});
  try {
    // Reject anything that isn't genuinely audio (e.g. a renamed executable).
    if (!looksLikeAudio(filePath)) {
      fs.rmSync(filePath, { force: true });
      recordRejection(displayName, "Not a recognised audio file", "upload", uploaderId);
      return { status: "failed", reason: "Not a recognised audio file" };
    }
    const r = await ingestFile(filePath, uploaderId, true /* dedupe */);
    if (!r) return { status: "failed" };
    await like(r.trackId); // uploads are auto-liked
    if (r.duplicate) {
      fs.rmSync(filePath, { force: true }); // same song already present
      return { status: "duplicate" };
    }
    if (r.created) {
      await fetchAndStoreLyrics(r.trackId).catch(() => {});
      queueAutotag(r.trackId); // background; no-op unless enabled
      queueLoudness(r.trackId); // background
      return { status: "added" };
    }
    return { status: "duplicate" }; // unchanged file already at this path
  } catch (e) {
    fs.rmSync(filePath, { force: true });
    if (e instanceof IngestRejectedError) {
      console.warn(`[upload] rejected ${filePath}: ${e.reason}`);
      recordRejection(displayName, e.reason, "upload", uploaderId);
      return { status: "failed", reason: e.reason };
    }
    console.error(`[upload] ingest failed for ${filePath}:`, (e as Error).message);
    return { status: "failed" };
  }
}

function tally(statuses: ({ name: string } & UploadOutcome)[]) {
  const pick = (s: UploadStatus) => statuses.filter((x) => x.status === s).map((x) => x.name);
  const added = pick("added");
  const failed = pick("failed");
  const duplicates = pick("duplicate");
  return {
    added: added.length,
    failed: failed.length,
    duplicates: duplicates.length,
    addedNames: added,
    failedNames: failed,
    duplicateNames: duplicates,
    // Subset of `failed` refused for a specific reason (broken audio, not audio).
    rejected: statuses
      .filter((x) => x.status === "failed" && x.reason)
      .map((x) => ({ name: x.name, reason: x.reason! })),
  };
}

/** A fresh, collision-free absolute path under the uploads directory. */
function uniqueUploadPath(originalName: string): string {
  const dir = path.join(env.musicPath, "uploads");
  fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(originalName).replace(/[\\/:*?"<>|]/g, "_");
  let name = base;
  let i = 1;
  while (fs.existsSync(path.join(dir, name))) {
    const ext = path.extname(base);
    name = `${path.basename(base, ext)} (${i++})${ext}`;
  }
  return path.join(dir, name);
}

/** POST /api/library/upload (multipart "files") — add audio; uploader auto-likes it */
router.post("/upload", upload.array("files", 50), async (req, res) => {
  const files = (req.files as Express.Multer.File[]) ?? [];
  if (files.length === 0) return res.status(400).json({ error: "No audio files uploaded" });
  const uploaderId = req.user!.id;
  const results: ({ name: string } & UploadOutcome)[] = [];
  for (const f of files) {
    results.push({
      name: f.originalname,
      ...(await processUploadedFile(f.path, uploaderId, f.originalname)),
    });
  }
  res.status(201).json(tally(results));
});

// ---- Chunked upload (for files larger than the CDN's request-body cap) -----
// Cloudflare caps a single request body at ~100MB, so large songs are uploaded
// in chunks (each well under the cap) and reassembled here.
//
// Each upload's temp file is namespaced by the authenticated user id, so nobody
// can append to / finalize someone else's upload by guessing its uploadId.
// Chunk bodies stream straight to disk (never buffered in RAM).
const CHUNK_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_CHUNK_BYTES = 120 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB per file
const MAX_CHUNKS = 2000;
const MAX_ACTIVE_UPLOADS = 4; // in-progress chunked uploads per user
const STALE_UPLOAD_MS = 60 * 60_000; // untouched this long → swept
const chunkTmpDir = () => path.join(env.musicPath, "tmp");

interface ChunkedUpload {
  userId: string;
  next: number; // index of the next expected chunk
  size: number; // bytes on disk so far
  offsets: number[]; // start offset of each received chunk (to rewind on retry)
  busy: boolean; // a chunk is being written right now
  touched: number; // epoch ms of the last activity
}
const chunkedUploads = new Map<string, ChunkedUpload>(); // temp path -> state

class UploadTooLargeError extends Error {}

function chunkTmpPath(userId: string, uploadId: string) {
  return path.join(chunkTmpDir(), `${userId.replace(/[^A-Za-z0-9_-]/g, "_")}_${uploadId}.part`);
}

function activeUploads(userId: string) {
  const cutoff = Date.now() - STALE_UPLOAD_MS;
  let n = 0;
  for (const u of chunkedUploads.values()) if (u.userId === userId && u.touched > cutoff) n++;
  return n;
}

/** Stream the request body onto the end of `file`, failing past `limit` bytes. */
async function appendBody(req: import("express").Request, file: string, limit: number) {
  let n = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      n += chunk.length;
      if (n > limit) cb(new UploadTooLargeError("Upload too large"));
      else cb(null, chunk);
    },
  });
  await pipeline(req, counter, fs.createWriteStream(file, { flags: "a" }));
  return n;
}

/** Delete temp parts (and their state) untouched for over an hour. */
function sweepStaleUploads() {
  const cutoff = Date.now() - STALE_UPLOAD_MS;
  for (const [p, u] of chunkedUploads) if (!u.busy && u.touched < cutoff) chunkedUploads.delete(p);
  let names: string[];
  try {
    names = fs.readdirSync(chunkTmpDir());
  } catch {
    return; // no tmp dir yet
  }
  for (const name of names) {
    if (!name.endsWith(".part")) continue;
    const p = path.join(chunkTmpDir(), name);
    if (chunkedUploads.get(p)?.busy) continue;
    try {
      if (fs.statSync(p).mtimeMs < cutoff) {
        fs.rmSync(p, { force: true });
        chunkedUploads.delete(p);
      }
    } catch {
      /* raced with finalize — fine */
    }
  }
}
sweepStaleUploads();
setInterval(sweepStaleUploads, 30 * 60_000).unref();

/** POST /api/library/upload/chunk?uploadId=&index= — append one raw chunk.
 *  Chunks arrive in order; re-sending an already-received index rewinds to it
 *  (so a client retry can't duplicate data). */
router.post("/upload/chunk", async (req, res) => {
  const userId = req.user!.id;
  const uploadId = qstr(req.query.uploadId) ?? "";
  const index = qnum(req.query.index);
  if (!CHUNK_ID.test(uploadId) || !Number.isInteger(index) || index < 0) {
    return res.status(400).json({ error: "Invalid chunk" });
  }
  if (index >= MAX_CHUNKS) return res.status(413).json({ error: "Too many chunks" });
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_CHUNK_BYTES) {
    return res.status(413).json({ error: "Chunk too large" });
  }

  const tmp = chunkTmpPath(userId, uploadId);
  let up = chunkedUploads.get(tmp);
  if (up?.busy) return res.status(409).json({ error: "Chunk already in progress" });
  if (index === 0) {
    if (!up && activeUploads(userId) >= MAX_ACTIVE_UPLOADS) {
      return res.status(429).json({ error: "Too many uploads in progress" });
    }
    up = { userId, next: 0, size: 0, offsets: [], busy: false, touched: Date.now() };
    chunkedUploads.set(tmp, up);
  } else if (!up) {
    // State lost (server restart) — adopt the caller's own temp file, if any.
    let size: number;
    try {
      size = fs.statSync(tmp).size;
    } catch {
      return res.status(400).json({ error: "Unknown upload" });
    }
    if (activeUploads(userId) >= MAX_ACTIVE_UPLOADS) {
      return res.status(429).json({ error: "Too many uploads in progress" });
    }
    up = { userId, next: index, size, offsets: [], busy: false, touched: Date.now() };
    chunkedUploads.set(tmp, up);
  }

  const start = index === up.next ? up.size : up.offsets[index];
  if (index > up.next || start === undefined) {
    return res.status(400).json({ error: "Out-of-order chunk" });
  }

  up.busy = true;
  up.touched = Date.now();
  try {
    fs.mkdirSync(chunkTmpDir(), { recursive: true });
    if (index === 0) fs.writeFileSync(tmp, "");
    else if (start < up.size) fs.truncateSync(tmp, start);
    up.size = start;
    up.next = index;
    up.offsets.length = index;

    const written = await appendBody(req, tmp, Math.min(MAX_CHUNK_BYTES, MAX_UPLOAD_BYTES - start));
    if (written === 0) return res.status(400).json({ error: "Empty chunk" });
    up.offsets[index] = start;
    up.size = start + written;
    up.next = index + 1;
    up.touched = Date.now();
    res.status(204).end();
  } catch (e) {
    if (e instanceof UploadTooLargeError) {
      // Over the per-chunk or per-file cap: abandon the whole upload.
      fs.rmSync(tmp, { force: true });
      chunkedUploads.delete(tmp);
      if (!res.headersSent) res.status(413).json({ error: "Upload too large" });
      return;
    }
    // Aborted / I/O error: rewind so the client can retry this chunk.
    try {
      fs.truncateSync(tmp, start);
    } catch {
      /* ignore */
    }
    if (!res.headersSent) res.status(400).json({ error: "Chunk upload failed" });
  } finally {
    up.busy = false;
  }
});

/** POST /api/library/upload/finalize { uploadId, filename } — assemble + ingest. */
router.post("/upload/finalize", async (req, res) => {
  const parsed = z
    .object({ uploadId: z.string(), filename: z.string().min(1) })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });
  const { uploadId, filename } = parsed.data;
  if (!CHUNK_ID.test(uploadId)) return res.status(400).json({ error: "Invalid input" });
  const tmp = chunkTmpPath(req.user!.id, uploadId); // only ever the caller's own upload
  if (chunkedUploads.get(tmp)?.busy) {
    return res.status(409).json({ error: "Chunk upload still in progress" });
  }
  if (!fs.existsSync(tmp)) return res.status(400).json({ error: "No upload data" });
  chunkedUploads.delete(tmp);
  if (!UPLOAD_EXT.has(path.extname(filename).toLowerCase())) {
    fs.rmSync(tmp, { force: true });
    recordRejection(path.basename(filename), "Unsupported file type", "upload", req.user!.id);
    return res.status(400).json({ error: "Only MP3 and FLAC files are allowed" });
  }
  const dest = uniqueUploadPath(filename);
  fs.renameSync(tmp, dest);
  const outcome = await processUploadedFile(dest, req.user!.id, path.basename(filename));
  res.status(201).json(tally([{ name: path.basename(filename), ...outcome }]));
});

export default router;
