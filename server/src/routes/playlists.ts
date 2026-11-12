import { Router } from "express";
import { z } from "zod";
import multer from "multer";
import path from "node:path";
import { promises as fsp } from "node:fs";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireMediaAuth } from "../middleware/auth.js";
import { env } from "../lib/env.js";
import {
  parseM3u,
  parseText,
  fetchSpotifyPlaylist,
  spotifyConfigured,
  matchEntries,
  entryLabel,
  ImportError,
  type ImportEntry,
} from "../services/playlistImport.js";
import {
  generatePlaylistCollage,
  saveCustomPlaylistCover,
  refreshAutoCollage,
  ImageRejectedError,
} from "../services/playlistCover.js";

const router = Router();

/** GET /api/playlists/:id/cover — collage (auto-generated on demand) or custom image.
 *  Registered before the router-wide requireAuth: <img> tags authenticate with
 *  `?token=` (a media token), which only the media routes accept. */
router.get("/:id/cover", requireMediaAuth, async (req, res) => {
  // Public (curated) playlists' covers are visible to everyone signed in — the
  // Home "Curated playlists" row shows other users' public playlists.
  const pl = await prisma.playlist.findFirst({
    where: {
      id: String(req.params.id),
      OR: [
        { isPublic: true },
        { userId: req.user!.id },
        { collaborators: { some: { userId: req.user!.id } } },
      ],
    },
  });
  if (!pl) return res.status(404).end();
  let rel = pl.coverPath;
  // Generate a collage lazily the first time (or if the file went missing).
  if (rel) {
    try {
      await fsp.access(path.resolve(env.dataPath, rel));
    } catch {
      rel = null;
    }
  }
  if (!rel) rel = await generatePlaylistCollage(pl.id).catch(() => null);
  if (!rel) return res.status(404).end();
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(path.resolve(env.dataPath, rel));
});

router.use(requireAuth);

const coverUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, file.mimetype.startsWith("image/")),
});

/** A playlist the user may view + edit tracks on: the owner OR a collaborator. */
function accessibleWhere(id: string, userId: string) {
  return { id, OR: [{ userId }, { collaborators: { some: { userId } } }] };
}

/** GET /api/playlists — playlists the user owns OR collaborates on, most-played first */
router.get("/", async (req, res) => {
  const userId = req.user!.id;
  const playlists = await prisma.playlist.findMany({
    where: { OR: [{ userId }, { collaborators: { some: { userId } } }] },
    include: {
      _count: { select: { tracks: true } },
      tracks: { select: { trackId: true } },
      user: { select: { username: true } },
      collaborators: { select: { userId: true } },
    },
  });
  // How many times the user has played each track, to rank playlists by total plays.
  const history = await prisma.playHistory.groupBy({
    by: ["trackId"],
    where: { userId },
    _count: { trackId: true },
  });
  const counts = new Map(history.map((h) => [h.trackId, h._count.trackId]));
  const ranked = playlists
    .map((pl) => {
      const playCount = pl.tracks.reduce((sum, t) => sum + (counts.get(t.trackId) ?? 0), 0);
      const { tracks: _tracks, user, collaborators, ...rest } = pl;
      return {
        ...rest,
        playCount,
        owned: pl.userId === userId,
        ownerName: user.username,
        collaboratorCount: collaborators.length,
      };
    })
    .sort((a, b) => b.playCount - a.playCount || b.createdAt.getTime() - a.createdAt.getTime());
  res.json(ranked);
});

/** GET /api/playlists/public — all public "curated" playlists (any owner), shown
 *  in every user's Home "Curated playlists" section. Registered before /:id. */
router.get("/public", async (_req, res) => {
  const playlists = await prisma.playlist.findMany({
    where: { isPublic: true },
    include: {
      _count: { select: { tracks: true } },
      user: { select: { username: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 40,
  });
  res.json(
    playlists.map((pl) => ({
      id: pl.id,
      name: pl.name,
      coverPath: pl.coverPath,
      trackCount: pl._count.tracks,
      ownerName: pl.user.username,
      isPublic: true,
    })),
  );
});

/** GET /api/playlists/:id — playlist with ordered tracks. Viewable by the owner,
 *  a collaborator, or — if it's public — any signed-in user; a private playlist
 *  is a 404 to everyone else (no existence leak). The `owned` flag gates edit
 *  controls. Mutations stay owner/collaborator-only. */
router.get("/:id", async (req, res) => {
  const userId = req.user!.id;
  const playlist = await prisma.playlist.findFirst({
    where: {
      id: String(req.params.id),
      OR: [{ isPublic: true }, { userId }, { collaborators: { some: { userId } } }],
    },
    include: {
      tracks: {
        orderBy: { position: "asc" },
        include: { track: { include: { artist: true, album: true } } },
      },
      user: { select: { id: true, username: true } },
      collaborators: { include: { user: { select: { id: true, username: true } } } },
    },
  });
  if (!playlist) return res.status(404).json({ error: "Not found" });
  const { user, collaborators, ...rest } = playlist;
  res.json({
    ...rest,
    owned: playlist.userId === userId,
    owner: user,
    collaborators: collaborators.map((c) => c.user),
  });
});

const importSchema = z.object({
  name: z.string().trim().min(1).max(120),
  source: z.enum(["m3u", "text", "spotify"]),
  content: z.string().max(5_000_000).optional(),
  url: z.string().max(500).optional(),
});

/** POST /api/playlists/import { name, source: "m3u"|"text"|"spotify", content?, url? }
 *  -> { playlistId, matched, total, unmatched }. Creates a playlist from an M3U
 *  file, an "Artist - Title" list, or a public Spotify playlist, fuzzy-matched
 *  against the library. */
router.post("/import", async (req, res) => {
  const parsed = importSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });
  const { name, source, content, url } = parsed.data;

  let entries: ImportEntry[];
  try {
    if (source === "spotify") {
      if (!spotifyConfigured()) {
        return res.status(400).json({ error: "Spotify import isn't configured on this server" });
      }
      if (!url) return res.status(400).json({ error: "A Spotify playlist link is required" });
      entries = await fetchSpotifyPlaylist(url);
    } else {
      if (!content?.trim()) return res.status(400).json({ error: "Nothing to import" });
      entries = source === "m3u" ? parseM3u(content) : parseText(content);
    }
  } catch (e) {
    if (e instanceof ImportError) return res.status(400).json({ error: e.message });
    throw e;
  }
  if (entries.length === 0) return res.status(400).json({ error: "No songs found to import" });

  const matches = await matchEntries(entries);
  const trackIds = [...new Set(matches.filter((id): id is string => !!id))];
  const unmatched = entries.filter((_, i) => !matches[i]).map(entryLabel);

  const playlist = await prisma.playlist.create({ data: { name, userId: req.user!.id } });
  if (trackIds.length) {
    await prisma.playlistTrack.createMany({
      data: trackIds.map((trackId, position) => ({ playlistId: playlist.id, trackId, position })),
      skipDuplicates: true,
    });
    refreshAutoCollage(playlist.id, false);
  }
  res.json({
    playlistId: playlist.id,
    matched: entries.length - unmatched.length,
    total: entries.length,
    unmatched: unmatched.slice(0, 1000),
  });
});

/** POST /api/playlists { name } */
router.post("/", async (req, res) => {
  const parsed = z.object({ name: z.string().min(1).max(120) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });
  const playlist = await prisma.playlist.create({
    data: { name: parsed.data.name, userId: req.user!.id },
  });
  res.status(201).json(playlist);
});

/** PATCH /api/playlists/:id { name?, isPublic? } — rename / toggle public (owner only) */
router.patch("/:id", async (req, res) => {
  const parsed = z
    .object({ name: z.string().min(1).max(120).optional(), isPublic: z.boolean().optional() })
    .safeParse(req.body);
  if (!parsed.success || (parsed.data.name === undefined && parsed.data.isPublic === undefined))
    return res.status(400).json({ error: "Invalid input" });
  const result = await prisma.playlist.updateMany({
    where: { id: req.params.id, userId: req.user!.id },
    data: parsed.data,
  });
  if (result.count === 0) return res.status(404).json({ error: "Not found" });
  res.json({ ok: true });
});

/** DELETE /api/playlists/:id — owner only */
router.delete("/:id", async (req, res) => {
  const result = await prisma.playlist.deleteMany({
    where: { id: req.params.id, userId: req.user!.id },
  });
  if (result.count === 0) return res.status(404).json({ error: "Not found" });
  res.status(204).end();
});

// ---- Collaborators --------------------------------------------------------

/** GET /api/playlists/:id/collaborators — owner + collaborators (owner or collaborator may view) */
router.get("/:id/collaborators", async (req, res) => {
  const pl = await prisma.playlist.findFirst({
    where: accessibleWhere(req.params.id, req.user!.id),
    include: {
      user: { select: { id: true, username: true } },
      collaborators: { include: { user: { select: { id: true, username: true } } } },
    },
  });
  if (!pl) return res.status(404).json({ error: "Not found" });
  res.json({ owner: pl.user, collaborators: pl.collaborators.map((c) => c.user) });
});

/** POST /api/playlists/:id/collaborators { userId } — add a collaborator (owner only) */
router.post("/:id/collaborators", async (req, res) => {
  const parsed = z.object({ userId: z.string() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });
  const pl = await prisma.playlist.findFirst({
    where: { id: req.params.id, userId: req.user!.id },
  });
  if (!pl) return res.status(404).json({ error: "Not found" });
  if (parsed.data.userId === req.user!.id) {
    return res.status(400).json({ error: "You already own this playlist" });
  }
  const target = await prisma.user.findUnique({ where: { id: parsed.data.userId } });
  if (!target) return res.status(404).json({ error: "User not found" });
  await prisma.playlistCollaborator.upsert({
    where: { playlistId_userId: { playlistId: pl.id, userId: parsed.data.userId } },
    create: { playlistId: pl.id, userId: parsed.data.userId },
    update: {},
  });
  res.status(201).json({ ok: true });
});

/** DELETE /api/playlists/:id/collaborators/:userId — remove a collaborator (owner only) */
router.delete("/:id/collaborators/:userId", async (req, res) => {
  const pl = await prisma.playlist.findFirst({
    where: { id: req.params.id, userId: req.user!.id },
  });
  if (!pl) return res.status(404).json({ error: "Not found" });
  await prisma.playlistCollaborator.deleteMany({
    where: { playlistId: pl.id, userId: req.params.userId },
  });
  res.status(204).end();
});

// ---- Tracks (owner or collaborator) ---------------------------------------

/** POST /api/playlists/:id/tracks { trackId } — append a track */
router.post("/:id/tracks", async (req, res) => {
  const parsed = z.object({ trackId: z.string() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });

  const playlist = await prisma.playlist.findFirst({
    where: accessibleWhere(req.params.id, req.user!.id),
  });
  if (!playlist) return res.status(404).json({ error: "Not found" });

  const last = await prisma.playlistTrack.findFirst({
    where: { playlistId: playlist.id },
    orderBy: { position: "desc" },
  });
  const position = (last?.position ?? -1) + 1;

  try {
    const item = await prisma.playlistTrack.create({
      data: { playlistId: playlist.id, trackId: parsed.data.trackId, position },
    });
    refreshAutoCollage(playlist.id, playlist.coverCustom); // keep the collage fresh
    res.status(201).json(item);
  } catch {
    res.status(409).json({ error: "Track already in playlist" });
  }
});

/** POST /api/playlists/:id/tracks/bulk { trackIds } — append many tracks at once,
 *  appended in the given order; tracks already in the playlist are skipped. */
router.post("/:id/tracks/bulk", async (req, res) => {
  const parsed = z.object({ trackIds: z.array(z.string()).min(1).max(2000) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });

  const playlist = await prisma.playlist.findFirst({
    where: accessibleWhere(req.params.id, req.user!.id),
  });
  if (!playlist) return res.status(404).json({ error: "Not found" });

  const last = await prisma.playlistTrack.findFirst({
    where: { playlistId: playlist.id },
    orderBy: { position: "desc" },
  });
  let position = (last?.position ?? -1) + 1;

  let added = 0;
  for (const trackId of parsed.data.trackIds) {
    try {
      await prisma.playlistTrack.create({
        data: { playlistId: playlist.id, trackId, position },
      });
      position++;
      added++;
    } catch {
      // Unique [playlistId, trackId] violation (already in playlist) or a bad
      // track id → skip it and keep going.
    }
  }
  if (added > 0) refreshAutoCollage(playlist.id, playlist.coverCustom);
  res.status(201).json({ added });
});

/** PATCH /api/playlists/:id/tracks/order { trackIds } — reorder (the full new
 *  order). Unknown ids are ignored; tracks missing from the list (e.g. added
 *  concurrently) keep their relative order after the listed ones. -> 204 */
router.patch("/:id/tracks/order", async (req, res) => {
  const parsed = z.object({ trackIds: z.array(z.string()).max(20_000) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });
  const playlist = await prisma.playlist.findFirst({
    where: accessibleWhere(req.params.id, req.user!.id),
  });
  if (!playlist) return res.status(404).json({ error: "Not found" });

  const rows = await prisma.playlistTrack.findMany({
    where: { playlistId: playlist.id },
    orderBy: { position: "asc" },
    select: { id: true, trackId: true },
  });
  const rowByTrack = new Map(rows.map((r) => [r.trackId, r.id]));
  const ordered: string[] = []; // PlaylistTrack ids in the new order
  const seen = new Set<string>();
  for (const trackId of parsed.data.trackIds) {
    const rowId = rowByTrack.get(trackId);
    if (!rowId || seen.has(rowId)) continue;
    seen.add(rowId);
    ordered.push(rowId);
  }
  for (const r of rows) if (!seen.has(r.id)) ordered.push(r.id);

  if (ordered.length) {
    // One statement: position = index in the array.
    await prisma.$executeRaw`
      UPDATE "PlaylistTrack" AS pt
      SET position = (v.ord - 1)::int
      FROM unnest(${ordered}::text[]) WITH ORDINALITY AS v(id, ord)
      WHERE pt.id = v.id AND pt."playlistId" = ${playlist.id}`;
  }
  refreshAutoCollage(playlist.id, playlist.coverCustom); // the collage uses the first covers
  res.status(204).end();
});

/** POST /api/playlists/:id/tracks/remove { trackIds } -> { removed } — bulk remove. */
router.post("/:id/tracks/remove", async (req, res) => {
  const parsed = z.object({ trackIds: z.array(z.string()).min(1).max(20_000) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });
  const playlist = await prisma.playlist.findFirst({
    where: accessibleWhere(req.params.id, req.user!.id),
  });
  if (!playlist) return res.status(404).json({ error: "Not found" });
  const r = await prisma.playlistTrack.deleteMany({
    where: { playlistId: playlist.id, trackId: { in: parsed.data.trackIds } },
  });
  if (r.count > 0) refreshAutoCollage(playlist.id, playlist.coverCustom);
  res.json({ removed: r.count });
});

/** DELETE /api/playlists/:id/tracks/:trackId */
router.delete("/:id/tracks/:trackId", async (req, res) => {
  const playlist = await prisma.playlist.findFirst({
    where: accessibleWhere(req.params.id, req.user!.id),
  });
  if (!playlist) return res.status(404).json({ error: "Not found" });
  await prisma.playlistTrack.deleteMany({
    where: { playlistId: playlist.id, trackId: req.params.trackId },
  });
  refreshAutoCollage(playlist.id, playlist.coverCustom);
  res.status(204).end();
});

// ---- Cover art ------------------------------------------------------------

/** POST /api/playlists/:id/cover/regenerate — rebuild the auto collage (owner only) */
router.post("/:id/cover/regenerate", async (req, res) => {
  const pl = await prisma.playlist.findFirst({
    where: { id: req.params.id, userId: req.user!.id },
  });
  if (!pl) return res.status(404).json({ error: "Not found" });
  await prisma.playlist.update({ where: { id: pl.id }, data: { coverCustom: false } });
  const rel = await generatePlaylistCollage(pl.id).catch(() => null);
  if (!rel) return res.status(422).json({ error: "No track covers to make a collage from" });
  res.json({ ok: true });
});

/** POST /api/playlists/:id/cover (multipart "cover") — upload a custom image (owner only) */
router.post("/:id/cover", coverUpload.single("cover"), async (req, res) => {
  const pl = await prisma.playlist.findFirst({
    where: { id: String(req.params.id), userId: req.user!.id },
  });
  if (!pl) return res.status(404).json({ error: "Not found" });
  if (!req.file) return res.status(400).json({ error: "No image uploaded" });
  try {
    await saveCustomPlaylistCover(pl.id, req.file.buffer);
    res.json({ ok: true });
  } catch (e) {
    // Oversized (decompression-bomb guard) / non-PNG-JPEG → explain; else generic.
    const msg = e instanceof ImageRejectedError ? e.message : "Could not process image";
    res.status(400).json({ error: msg });
  }
});

export default router;
