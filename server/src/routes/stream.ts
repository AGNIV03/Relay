import { Router } from "express";
import { promises as fs, createReadStream } from "node:fs";
import path from "node:path";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { transcodeStream, CONTENT_TYPE, type TranscodeOptions } from "../services/transcode.js";

const router = Router();

const MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  flac: "audio/flac",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  opus: "audio/opus",
  wav: "audio/wav",
  wma: "audio/x-ms-wma",
};

/** GET /api/stream/album/:albumId/cover — album art (registered before /:trackId). */
router.get("/album/:albumId/cover", requireAuth, async (req, res) => {
  const album = await prisma.album.findUnique({ where: { id: req.params.albumId } });
  if (!album?.coverPath) return res.status(404).end();
  const { env } = await import("../lib/env.js");
  res.sendFile(path.resolve(env.dataPath, album.coverPath));
});

/**
 * GET /api/stream/:trackId
 *   ?format=mp3|opus|aac & bitrate=128   -> transcode on the fly
 *   (no params)                          -> direct file with HTTP Range support
 */
router.get("/:trackId", requireAuth, async (req, res) => {
  const track = await prisma.track.findUnique({ where: { id: req.params.trackId } });
  if (!track) return res.status(404).json({ error: "Track not found" });

  try {
    await fs.access(track.path);
  } catch {
    return res.status(410).json({ error: "File no longer exists on disk" });
  }

  // --- Transcoding path ---
  const format = req.query.format as TranscodeOptions["format"] | undefined;
  if (format && format in CONTENT_TYPE) {
    const bitrate = Math.min(Math.max(Number(req.query.bitrate) || 128, 32), 320);
    res.setHeader("Content-Type", CONTENT_TYPE[format]);
    res.setHeader("Accept-Ranges", "none");
    const ff = transcodeStream(track.path, { format, bitrate });
    ff.pipe(res);
    req.on("close", () => ff.destroy());
    return;
  }

  // --- Direct file path with Range support (seeking) ---
  const stat = await fs.stat(track.path);
  const total = stat.size;
  const mime = MIME[path.extname(track.path).slice(1).toLowerCase()] ?? "application/octet-stream";
  const range = req.headers.range;

  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    const start = match && match[1] ? parseInt(match[1], 10) : 0;
    const end = match && match[2] ? parseInt(match[2], 10) : total - 1;
    if (start >= total || end >= total) {
      res.setHeader("Content-Range", `bytes */${total}`);
      return res.status(416).end();
    }
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Length", end - start + 1);
    res.setHeader("Content-Type", mime);
    createReadStream(track.path, { start, end }).pipe(res);
  } else {
    res.setHeader("Content-Length", total);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type", mime);
    createReadStream(track.path).pipe(res);
  }
});

/** GET /api/stream/:trackId/cover — album art for the track (no auth-in-header friendly). */
router.get("/:trackId/cover", requireAuth, async (req, res) => {
  const track = await prisma.track.findUnique({
    where: { id: req.params.trackId },
    include: { album: true },
  });
  const coverPath = track?.album?.coverPath;
  if (!coverPath) return res.status(404).end();
  const { env } = await import("../lib/env.js");
  res.sendFile(path.resolve(env.dataPath, coverPath));
});

export default router;
