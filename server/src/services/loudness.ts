// Integrated loudness (EBU R128) measurement for volume normalization.
//
// Measured once per track with ffmpeg's ebur128 filter, in the background after
// ingest (never on the request path) plus a capped backfill each scan. Clients
// use Track.loudnessLufs to attenuate loud tracks toward -14 LUFS. A failure
// (ffmpeg missing, timeout, unreadable file) leaves the value null; the track is
// skipped by backfills until the next restart.
import { spawn } from "node:child_process";
import { prisma } from "../lib/prisma.js";

const MAX_CONCURRENT = 1; // a full decode per track: keep it to one core
const MAX_PENDING = 2000;
const TIMEOUT_MS = 180_000;
const SILENCE_LUFS = -70; // ebur128's absolute gate; used when it reports -inf

const inflight = new Set<string>(); // queued or running
const pending: string[] = [];
const failedThisRun = new Set<string>();
let running = 0;
let ffmpegMissing = false;

/** Measure a file's integrated loudness in LUFS, or null if it can't. */
export function measureLoudness(file: string): Promise<number | null> {
  return new Promise((resolve) => {
    const args = [
      "-nostdin", "-hide_banner", "-nostats", "-v", "info",
      "-protocol_whitelist", "file",
      "-i", file,
      "-map", "0:a:0",
      "-af", "ebur128=framelog=quiet",
      "-f", "null",
      "-",
    ];
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    } catch {
      return resolve(null);
    }
    let tail = "";
    let done = false;
    const finish = (v: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      finish(null);
    }, TIMEOUT_MS);
    proc.stderr!.setEncoding("utf8");
    proc.stderr!.on("data", (c: string) => {
      tail = (tail + c).slice(-8192); // the summary is printed last
    });
    proc.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT" && !ffmpegMissing) {
        ffmpegMissing = true;
        console.warn("[loudness] ffmpeg not found on PATH; loudness measurement disabled");
      }
      finish(null);
    });
    proc.on("close", (code) => {
      if (code !== 0) return finish(null);
      finish(parseIntegrated(tail));
    });
  });
}

/** Pull "I: -14.2 LUFS" out of the ebur128 summary. */
export function parseIntegrated(log: string): number | null {
  const m =
    /Integrated loudness:\s*I:\s*(-?[\d.]+|-inf)\s*LUFS/i.exec(log) ??
    [...log.matchAll(/\bI:\s*(-?[\d.]+|-inf)\s*LUFS/gi)].pop() ??
    null;
  if (!m) return null;
  if (m[1].toLowerCase() === "-inf") return SILENCE_LUFS;
  const v = Number(m[1]);
  if (!Number.isFinite(v)) return null;
  return Math.max(SILENCE_LUFS, Math.min(10, Math.round(v * 10) / 10));
}

async function measureOne(trackId: string): Promise<void> {
  const t = await prisma.track.findUnique({
    where: { id: trackId },
    select: { path: true, loudnessLufs: true },
  });
  if (!t || t.loudnessLufs !== null) return;
  const lufs = await measureLoudness(t.path);
  if (lufs === null) {
    failedThisRun.add(trackId);
    return;
  }
  await prisma.track.update({ where: { id: trackId }, data: { loudnessLufs: lufs } }).catch(() => {});
}

function runNext() {
  while (running < MAX_CONCURRENT && pending.length) {
    const id = pending.shift()!;
    running++;
    measureOne(id)
      .catch((e) => {
        failedThisRun.add(id);
        console.warn(`[loudness] ${id} failed:`, (e as Error).message);
      })
      .finally(() => {
        running--;
        inflight.delete(id);
        runNext();
      });
  }
}

/** Queue a track for measurement (fire-and-forget; deduped; no-op without ffmpeg). */
export function queueLoudness(trackId: string): void {
  if (ffmpegMissing || inflight.has(trackId) || inflight.size >= MAX_PENDING) return;
  inflight.add(trackId);
  pending.push(trackId);
  runNext();
}

/** Scan backfill: queue up to `limit` tracks never measured. Returns immediately
 *  (the measurements run in the background). Never throws. */
export async function backfillLoudness(limit = 200): Promise<void> {
  if (ffmpegMissing) return;
  try {
    const rows = await prisma.track.findMany({
      where: { loudnessLufs: null, id: { notIn: [...failedThisRun, ...inflight] } },
      select: { id: true },
      take: limit,
    });
    for (const r of rows) queueLoudness(r.id);
  } catch (e) {
    console.warn("[loudness] backfill failed:", (e as Error).message);
  }
}
