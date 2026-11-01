import { promises as fs } from "node:fs";
import path from "node:path";
import { Jimp } from "jimp";
import { prisma } from "../lib/prisma.js";
import { env } from "../lib/env.js";

const SIZE = 640;

function relFor(playlistId: string) {
  return path.join("covers", `playlist_${playlistId}.jpg`);
}

// ---- Decompression-bomb guard ----------------------------------------------
// Jimp decodes to a full RGBA bitmap (4 bytes/pixel), so a tiny file declaring
// e.g. 50000×50000 px would try to allocate ~10 GB. Read the declared size from
// the header first and refuse anything beyond these limits.
export const MAX_IMAGE_SIDE = 4096;
export const MAX_IMAGE_PIXELS = 20_000_000;

/** Thrown by saveCustomPlaylistCover for an oversized / unrecognised image. */
export class ImageRejectedError extends Error {}

type ByteReader = (pos: number, len: number) => Promise<Buffer>;

async function readDimensions(read: ByteReader): Promise<{ width: number; height: number } | null> {
  const head = await read(0, 24);
  // PNG: 8-byte signature, then the IHDR chunk (len, "IHDR", width, height — BE).
  if (
    head.length >= 24 &&
    head.readUInt32BE(0) === 0x89504e47 &&
    head.readUInt32BE(4) === 0x0d0a1a0a &&
    head.toString("latin1", 12, 16) === "IHDR"
  ) {
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  }
  // JPEG: SOI, then walk the marker segments to the first SOFn frame header.
  if (head.length >= 4 && head[0] === 0xff && head[1] === 0xd8) {
    let pos = 2;
    for (let guard = 0; guard < 1000; guard++) {
      const seg = await read(pos, 9);
      if (seg.length < 4 || seg[0] !== 0xff) return null;
      const marker = seg[1];
      if (marker === 0xff) {
        pos += 1; // fill byte
        continue;
      }
      // Standalone markers (no length): TEM, RST0-7, SOI.
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
        pos += 2;
        continue;
      }
      if (marker === 0xd9 || marker === 0xda) return null; // EOI / scan data before a frame
      // SOF0-SOF15, except DHT (C4), JPG (C8) and DAC (CC), which share the range.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        if (seg.length < 9) return null;
        return { width: seg.readUInt16BE(7), height: seg.readUInt16BE(5) };
      }
      const segLen = seg.readUInt16BE(2);
      if (segLen < 2) return null;
      pos += 2 + segLen;
    }
  }
  return null; // unknown / unsupported format
}

/** Pixel dimensions declared in a PNG/JPEG header (file path or bytes), without
 *  decoding the image. Null for unknown formats or a malformed header. */
export async function imageDimensions(
  src: string | Buffer,
): Promise<{ width: number; height: number } | null> {
  if (Buffer.isBuffer(src)) {
    return readDimensions(async (pos, len) => src.subarray(pos, pos + len));
  }
  const fh = await fs.open(src, "r");
  try {
    return await readDimensions(async (pos, len) => {
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, pos);
      return buf.subarray(0, bytesRead);
    });
  } finally {
    await fh.close();
  }
}

/** True if the image is a PNG/JPEG within the size limits (safe to decode). */
export async function isSafeImage(src: string | Buffer): Promise<boolean> {
  const dim = await imageDimensions(src).catch(() => null);
  return (
    !!dim &&
    dim.width > 0 &&
    dim.height > 0 &&
    dim.width <= MAX_IMAGE_SIDE &&
    dim.height <= MAX_IMAGE_SIDE &&
    dim.width * dim.height <= MAX_IMAGE_PIXELS
  );
}

/** Up to 4 distinct, existing album-cover files from a playlist's tracks. */
async function coverFilesFor(playlistId: string): Promise<string[]> {
  const pl = await prisma.playlist.findUnique({
    where: { id: playlistId },
    include: {
      tracks: {
        orderBy: { position: "asc" },
        include: { track: { include: { album: true } } },
      },
    },
  });
  if (!pl) return [];
  const seen = new Set<string>();
  const files: string[] = [];
  for (const pt of pl.tracks) {
    const cp = pt.track.album?.coverPath;
    if (!cp || seen.has(cp)) continue;
    const abs = path.resolve(env.dataPath, cp);
    seen.add(cp);
    // Missing, unrecognised or oversized (decompression bomb) files are skipped.
    if (await isSafeImage(abs)) files.push(abs);
    if (files.length >= 4) break;
  }
  return files;
}

/**
 * Generate (or regenerate) a collage cover for a playlist: a 2×2 mosaic of the
 * first 4 distinct track covers, or a single cover if fewer. Persists the path
 * on the playlist. Returns the relative path, or null if there are no covers.
 */
export async function generatePlaylistCollage(playlistId: string): Promise<string | null> {
  const files = await coverFilesFor(playlistId);
  if (files.length === 0) return null;

  const canvas = new Jimp({ width: SIZE, height: SIZE, color: 0x131316ff });
  if (files.length >= 4) {
    const half = SIZE / 2;
    const pos: [number, number][] = [
      [0, 0],
      [half, 0],
      [0, half],
      [half, half],
    ];
    for (let i = 0; i < 4; i++) {
      const img = await Jimp.read(files[i]);
      img.cover({ w: half, h: half });
      canvas.composite(img, pos[i][0], pos[i][1]);
    }
  } else {
    const img = await Jimp.read(files[0]);
    img.cover({ w: SIZE, h: SIZE });
    canvas.composite(img, 0, 0);
  }

  const rel = relFor(playlistId);
  await fs.mkdir(path.join(env.dataPath, "covers"), { recursive: true });
  const buf = await canvas.getBuffer("image/jpeg");
  await fs.writeFile(path.join(env.dataPath, rel), buf);
  await prisma.playlist.update({ where: { id: playlistId }, data: { coverPath: rel } });
  return rel;
}

/** Save a user-uploaded image as the playlist's (custom) cover. Throws
 *  ImageRejectedError for anything but a PNG/JPEG within the size limits. */
export async function saveCustomPlaylistCover(playlistId: string, buffer: Buffer): Promise<string> {
  if (!(await isSafeImage(buffer))) {
    throw new ImageRejectedError(
      `Image must be a PNG or JPEG of at most ${MAX_IMAGE_SIDE}×${MAX_IMAGE_SIDE} pixels`,
    );
  }
  const img = await Jimp.read(buffer);
  img.cover({ w: SIZE, h: SIZE });
  const rel = relFor(playlistId);
  await fs.mkdir(path.join(env.dataPath, "covers"), { recursive: true });
  await fs.writeFile(path.join(env.dataPath, rel), await img.getBuffer("image/jpeg"));
  await prisma.playlist.update({
    where: { id: playlistId },
    data: { coverPath: rel, coverCustom: true },
  });
  return rel;
}

/** Refresh the auto-collage after a track change (no-op for custom covers). */
export function refreshAutoCollage(playlistId: string, coverCustom: boolean) {
  if (coverCustom) return;
  generatePlaylistCollage(playlistId).catch(() => {});
}
