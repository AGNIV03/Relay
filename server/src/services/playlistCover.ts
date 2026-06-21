import { promises as fs } from "node:fs";
import path from "node:path";
import { Jimp } from "jimp";
import { prisma } from "../lib/prisma.js";
import { env } from "../lib/env.js";

const SIZE = 640;

function relFor(playlistId: string) {
  return path.join("covers", `playlist_${playlistId}.jpg`);
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
    try {
      await fs.access(abs);
      seen.add(cp);
      files.push(abs);
    } catch {
      /* missing file — skip */
    }
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

/** Save a user-uploaded image as the playlist's (custom) cover. */
export async function saveCustomPlaylistCover(playlistId: string, buffer: Buffer): Promise<string> {
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
