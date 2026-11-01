import fs from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";

/**
 * Thrown by ingest when a file is refused outright (not merely a duplicate) —
 * e.g. it has no decodable audio. `reason` is safe to show to the uploader.
 */
export class IngestRejectedError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = "IngestRejectedError";
    this.reason = reason;
  }
}

/**
 * Sniff the first bytes to confirm the file is genuinely audio — not a renamed
 * executable/script. Recognizes FLAC ("fLaC"), MP3 ("ID3" tag or MPEG/AAC-ADTS
 * frame sync), OGG ("OggS"), WAV ("RIFF"…"WAVE"), MP4/M4A/AAC ("…ftyp"), plus
 * AIFF ("FORM"…"AIFF"/"AIFC") and WMA (ASF GUID) for the admin upload path.
 */
export function looksLikeAudio(filePath: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(16);
    const n = fs.readSync(fd, buf, 0, 16, 0);
    if (n < 4) return false;
    const head = buf.toString("latin1", 0, 4);
    if (head === "fLaC") return true; // FLAC
    if (buf.toString("latin1", 0, 3) === "ID3") return true; // MP3 with ID3v2
    if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return true; // MPEG / AAC-ADTS frame sync
    if (head === "OggS") return true; // OGG (Vorbis / Opus)
    if (head === "RIFF" && buf.toString("latin1", 8, 12) === "WAVE") return true; // WAV
    if (n >= 8 && buf.toString("latin1", 4, 8) === "ftyp") return true; // MP4 / M4A / AAC (incl. ALAC)
    if (head === "FORM" && /^AIF[FC]$/.test(buf.toString("latin1", 8, 12))) return true; // AIFF
    if (n >= 16 && buf.subarray(0, 16).equals(ASF_GUID)) return true; // WMA (ASF container)
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// ASF header object GUID 75B22630-668E-11CF-A6D9-00AA0062CE6C, as laid out on disk.
const ASF_GUID = Buffer.from("3026b2758e66cf11a6d900aa0062ce6c", "hex");

/** SHA-256 of a file's contents (streamed — never buffers the whole file). */
export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest("hex");
}

const DECODE_TIMEOUT_MS = 120_000;
let ffmpegMissingLogged = false;

/**
 * Fully decode the first audio stream (to /dev/null) and make sure enough of it
 * is actually playable. Catches files whose headers look fine but hold no audio
 * — e.g. a FLAC claiming 405s that is really just embedded album art.
 *
 * Throws IngestRejectedError when the file is broken. Anything that prevents a
 * verdict (ffmpeg missing, timeout) is logged and the file is accepted.
 */
export async function verifyDecodes(filePath: string, claimedSeconds: number): Promise<void> {
  const claimed = Number.isFinite(claimedSeconds) && claimedSeconds > 0 ? claimedSeconds : 0;
  // Need max(3s, half the claimed length). A genuinely sub-3s clip only needs half.
  const minSeconds = claimed > 0 && claimed < 3 ? claimed * 0.5 : Math.max(3, claimed * 0.5);

  const r = await decodeDuration(filePath);
  if (r.kind === "unverified") {
    console.warn(`[ingest] could not verify audio for ${filePath}: ${r.why} — accepting`);
    return;
  }
  if (r.kind === "no-audio") {
    throw new IngestRejectedError("No audio stream found in file");
  }
  // A non-zero exit that still produced plenty of audio is tolerated (trailing junk).
  if (r.decodedSeconds < minSeconds) {
    throw new IngestRejectedError("No playable audio (file appears truncated or corrupt)");
  }
}

type DecodeResult =
  | { kind: "ok"; decodedSeconds: number; exitCode: number | null }
  | { kind: "no-audio" }
  | { kind: "unverified"; why: string };

function decodeDuration(filePath: string): Promise<DecodeResult> {
  return new Promise((resolve) => {
    const args = [
      "-nostdin", "-hide_banner", "-v", "error",
      "-i", filePath,
      "-map", "0:a:0",
      "-f", "null",
      "-progress", "pipe:1",
      "-",
    ];
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      return resolve({ kind: "unverified", why: (e as Error).message });
    }

    let lastUs = -1; // last decoded position reported by -progress, microseconds
    let stdoutTail = "";
    let stderrTail = "";
    let settled = false;
    const settle = (r: DecodeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    proc.stdout!.setEncoding("utf8");
    proc.stdout!.on("data", (chunk: string) => {
      const text = stdoutTail + chunk;
      const lines = text.split("\n");
      stdoutTail = lines.pop() ?? "";
      for (const line of lines) {
        // out_time_us is microseconds; out_time_ms is ALSO microseconds (an old
        // ffmpeg naming quirk) — take whichever is present and numeric.
        const m = /^out_time_(?:us|ms)=(\d+)/.exec(line.trim());
        if (m) lastUs = Math.max(lastUs, Number(m[1]));
      }
    });
    proc.stderr!.setEncoding("utf8");
    proc.stderr!.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-4096);
    });

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      settle({ kind: "unverified", why: `decode timed out after ${DECODE_TIMEOUT_MS / 1000}s` });
    }, DECODE_TIMEOUT_MS);

    proc.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") {
        if (!ffmpegMissingLogged) {
          ffmpegMissingLogged = true;
          console.warn("[ingest] ffmpeg not found on PATH — skipping decode checks");
        }
        return settle({ kind: "unverified", why: "ffmpeg not installed" });
      }
      settle({ kind: "unverified", why: e.message });
    });

    proc.on("close", (code) => {
      const decodedSeconds = lastUs > 0 ? lastUs / 1_000_000 : 0;
      if (code !== 0 && /matches no streams|does not contain any stream|no audio/i.test(stderrTail)) {
        return settle({ kind: "no-audio" });
      }
      settle({ kind: "ok", decodedSeconds, exitCode: code });
    });
  });
}
