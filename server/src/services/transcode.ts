import { spawn } from "node:child_process";
import type { Readable } from "node:stream";

export interface TranscodeOptions {
  format: "mp3" | "opus" | "aac";
  bitrate: number; // kbps
}

const FORMAT_ARGS: Record<TranscodeOptions["format"], string[]> = {
  mp3: ["-f", "mp3", "-codec:a", "libmp3lame"],
  opus: ["-f", "ogg", "-codec:a", "libopus"],
  aac: ["-f", "adts", "-codec:a", "aac"],
};

export const CONTENT_TYPE: Record<TranscodeOptions["format"], string> = {
  mp3: "audio/mpeg",
  opus: "audio/ogg",
  aac: "audio/aac",
};

/**
 * Transcode a file on the fly with ffmpeg and return a readable stream of the
 * encoded audio. Used when a client requests a different format/bitrate (e.g. a
 * phone on mobile data wants 128k mp3 instead of a 900k FLAC).
 *
 * Note: transcoded streams are not seekable via byte ranges — clients should
 * request the original file for scrubbing, or re-request to seek.
 */
export function transcodeStream(inputPath: string, opts: TranscodeOptions): Readable {
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    inputPath,
    "-vn", // drop embedded cover art / video streams
    "-map_metadata",
    "-1",
    ...FORMAT_ARGS[opts.format],
    "-b:a",
    `${opts.bitrate}k`,
    "pipe:1",
  ];
  const ff = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
  ff.stderr.on("data", (d) => console.error("[ffmpeg]", d.toString().trim()));
  ff.on("error", (e) => console.error("[ffmpeg] spawn failed:", e.message));
  return ff.stdout;
}
