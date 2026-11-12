import { Router } from "express";
import { promises as fs, createReadStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream";
import { prisma } from "../lib/prisma.js";
import { qstr, qnum } from "../lib/query.js";
import { requireMediaAuth } from "../middleware/auth.js";
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

// ---- Concurrent transcode limits -------------------------------------------
const MAX_TRANSCODES_PER_USER = 3;
const MAX_TRANSCODES_GLOBAL = 8;
let activeTranscodes = 0;
const transcodesByUser = new Map<string, number>();

function acquireTranscode(userId: string) {
  activeTranscodes++;
  transcodesByUser.set(userId, (transcodesByUser.get(userId) ?? 0) + 1);
}

function releaseTranscode(userId: string) {
  activeTranscodes = Math.max(0, activeTranscodes - 1);
  const n = (transcodesByUser.get(userId) ?? 1) - 1;
  if (n <= 0) transcodesByUser.delete(userId);
  else transcodesByUser.set(userId, n);
}

/**
 * Parse a single-range `Range: bytes=…` header against a file of `total` bytes.
 * Returns null to serve the whole file (no header, or a form we don't support —
 * e.g. multi-range — which RFC 9110 lets us ignore), "unsatisfiable" for a 416,
 * or the inclusive byte span. Supports `a-b`, `a-` and suffix `-n` (last n bytes);
 * an end past EOF is clamped to the last byte.
 */
export function parseRange(
  header: string | undefined,
  total: number,
): { start: number; end: number } | "unsatisfiable" | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (!m[1] && !m[2])) return null;
  let start: number;
  let end: number;
  if (!m[1]) {
    // Suffix range: the last n bytes.
    const n = parseInt(m[2], 10);
    if (n === 0 || total === 0) return "unsatisfiable";
    start = Math.max(0, total - n);
    end = total - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] ? Math.min(parseInt(m[2], 10), total - 1) : total - 1;
  }
  if (!Number.isSafeInteger(start) || start >= total || start > end) return "unsatisfiable";
  return { start, end };
}

/** GET /api/stream/album/:albumId/cover — album art (registered before /:trackId). */
router.get("/album/:albumId/cover", requireMediaAuth, async (req, res) => {
  const album = await prisma.album.findUnique({ where: { id: String(req.params.albumId) } });
  if (!album?.coverPath) return res.status(404).end();
  const { env } = await import("../lib/env.js");
  // Covers are effectively immutable per album/track id — let clients cache them
  // for a week so scrolling lists / reopening panels don't refetch every image.
  res.sendFile(path.resolve(env.dataPath, album.coverPath), { maxAge: "7d" });
});

/**
 * GET /api/stream/:trackId
 *   ?format=mp3|opus|aac & bitrate=128   -> transcode on the fly
 *   (no params)                          -> direct file with HTTP Range support
 */
router.get("/:trackId", requireMediaAuth, async (req, res) => {
  const track = await prisma.track.findUnique({
    where: { id: String(req.params.trackId) },
    select: { path: true },
  });
  if (!track) return res.status(404).json({ error: "Track not found" });

  try {
    await fs.access(track.path);
  } catch {
    return res.status(410).json({ error: "File no longer exists on disk" });
  }

  // --- Transcoding path ---
  const format = qstr(req.query.format);
  if (format && Object.hasOwn(CONTENT_TYPE, format)) {
    const fmt = format as TranscodeOptions["format"];
    const userId = req.user!.id;
    // ffmpeg is CPU-heavy: bound how many run at once (per user and overall).
    if (
      activeTranscodes >= MAX_TRANSCODES_GLOBAL ||
      (transcodesByUser.get(userId) ?? 0) >= MAX_TRANSCODES_PER_USER
    ) {
      return res.status(429).json({ error: "Too many concurrent transcodes — try again shortly" });
    }
    const bitrate = Math.min(Math.max(qnum(req.query.bitrate) || 128, 32), 320);
    res.setHeader("Content-Type", CONTENT_TYPE[fmt]);
    res.setHeader("Accept-Ranges", "none");
    const ff = transcodeStream(track.path, { format: fmt, bitrate });
    acquireTranscode(userId);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      releaseTranscode(userId);
    };
    ff.on("close", release);
    ff.on("error", release); // spawn failure may not emit "close"
    // pipeline (unlike .pipe) tears both sides down on error and never throws.
    pipeline(ff.stdout, res, () => {});
    // Kill the ffmpeg process (not just the pipe) when the client disconnects,
    // otherwise it keeps transcoding orphaned. (Also fires after a normal finish,
    // when ffmpeg has already exited — kill is then a no-op.)
    res.on("close", () => {
      if (ff.exitCode === null && ff.signalCode === null) ff.kill("SIGKILL");
    });
    return;
  }

  // --- Direct file path with Range support (seeking) ---
  const stat = await fs.stat(track.path);
  const total = stat.size;
  const mime = MIME[path.extname(track.path).slice(1).toLowerCase()] ?? "application/octet-stream";
  const range = parseRange(req.headers.range, total);

  res.setHeader("Accept-Ranges", "bytes");
  if (range === "unsatisfiable") {
    res.setHeader("Content-Range", `bytes */${total}`);
    return res.status(416).end();
  }
  res.setHeader("Content-Type", mime);
  if (range) {
    const { start, end } = range;
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
    res.setHeader("Content-Length", end - start + 1);
    pipeline(createReadStream(track.path, { start, end }), res, () => {});
  } else {
    res.setHeader("Content-Length", total);
    pipeline(createReadStream(track.path), res, () => {});
  }
});

/** GET /api/stream/:trackId/cover — album art for the track (no auth-in-header friendly). */
router.get("/:trackId/cover", requireMediaAuth, async (req, res) => {
  const track = await prisma.track.findUnique({
    where: { id: String(req.params.trackId) },
    include: { album: true },
  });
  const coverPath = track?.album?.coverPath;
  if (!coverPath) return res.status(404).end();
  const { env } = await import("../lib/env.js");
  res.sendFile(path.resolve(env.dataPath, coverPath), { maxAge: "7d" });
});

export default router;
