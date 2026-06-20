import { promises as fs } from "node:fs";
import path from "node:path";
import { parseFile } from "music-metadata";
import { prisma } from "../lib/prisma.js";
import { env } from "../lib/env.js";

const AUDIO_EXT = new Set([".mp3", ".flac", ".m4a", ".aac", ".ogg", ".opus", ".wav", ".wma"]);

export interface ScanResult {
  scanned: number;
  added: number;
  updated: number;
  removed: number;
  errors: number;
}

let scanning = false;
let lastResult: ScanResult | null = null;

export function getScanStatus() {
  return { scanning, lastResult };
}

async function* walk(dir: string): AsyncGenerator<string> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable dir — skip
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (AUDIO_EXT.has(path.extname(entry.name).toLowerCase())) {
      yield full;
    }
  }
}

async function findOrCreateArtist(name: string): Promise<string> {
  const clean = name.trim() || "Unknown Artist";
  const existing = await prisma.artist.findUnique({ where: { name: clean } });
  if (existing) return existing.id;
  const created = await prisma.artist.create({ data: { name: clean } });
  return created.id;
}

async function findOrCreateAlbum(
  title: string,
  artistId: string,
  year: number | undefined,
): Promise<string> {
  const clean = title.trim() || "Unknown Album";
  const existing = await prisma.album.findUnique({
    where: { title_artistId: { title: clean, artistId } },
  });
  if (existing) return existing.id;
  const created = await prisma.album.create({ data: { title: clean, artistId, year } });
  return created.id;
}

/** Save embedded cover art to DATA_PATH/covers/<albumId>.<ext>, return relative path. */
async function saveCover(albumId: string, picture: { format: string; data: Uint8Array }) {
  const ext = picture.format.includes("png") ? "png" : "jpg";
  const dir = path.join(env.dataPath, "covers");
  await fs.mkdir(dir, { recursive: true });
  const rel = path.join("covers", `${albumId}.${ext}`);
  await fs.writeFile(path.join(env.dataPath, rel), Buffer.from(picture.data));
  return rel;
}

async function processFile(file: string, result: ScanResult) {
  const stat = await fs.stat(file);
  const existing = await prisma.track.findUnique({ where: { path: file } });

  // Skip unchanged files (same size) on rescans for speed.
  if (existing && existing.size === stat.size) {
    result.scanned++;
    return;
  }

  const meta = await parseFile(file, { duration: true });
  const common = meta.common;
  const fmt = meta.format;

  const artistName = common.artist || common.albumartist || "Unknown Artist";
  const artistId = await findOrCreateArtist(artistName);
  const albumId = await findOrCreateAlbum(common.album || "Unknown Album", artistId, common.year);

  // Cover art: store once per album if we don't have one yet.
  const album = await prisma.album.findUnique({ where: { id: albumId } });
  if (album && !album.coverPath && common.picture?.[0]) {
    const rel = await saveCover(albumId, common.picture[0]);
    await prisma.album.update({ where: { id: albumId }, data: { coverPath: rel } });
  }

  const data = {
    title: common.title || path.basename(file, path.extname(file)),
    duration: fmt.duration ?? 0,
    trackNo: common.track?.no ?? null,
    discNo: common.disk?.no ?? null,
    genre: common.genre?.[0] ?? null,
    format: path.extname(file).slice(1).toLowerCase(),
    bitrate: fmt.bitrate ? Math.round(fmt.bitrate / 1000) : null,
    size: stat.size,
    albumId,
    artistId,
  };

  if (existing) {
    await prisma.track.update({ where: { id: existing.id }, data });
    result.updated++;
  } else {
    await prisma.track.create({ data: { ...data, path: file } });
    result.added++;
  }
  result.scanned++;
}

/** Remove DB tracks whose files no longer exist on disk. */
async function pruneMissing(result: ScanResult) {
  const tracks = await prisma.track.findMany({ select: { id: true, path: true } });
  for (const t of tracks) {
    try {
      await fs.access(t.path);
    } catch {
      await prisma.track.delete({ where: { id: t.id } });
      result.removed++;
    }
  }
  // Clean up albums/artists with no remaining tracks.
  await prisma.album.deleteMany({ where: { tracks: { none: {} } } });
  await prisma.artist.deleteMany({ where: { tracks: { none: {} }, albums: { none: {} } } });
}

export async function runScan(): Promise<ScanResult> {
  if (scanning) throw new Error("A scan is already in progress");
  scanning = true;
  const result: ScanResult = { scanned: 0, added: 0, updated: 0, removed: 0, errors: 0 };
  try {
    for await (const file of walk(env.musicPath)) {
      try {
        await processFile(file, result);
      } catch (err) {
        result.errors++;
        console.error(`[scan] failed on ${file}:`, (err as Error).message);
      }
    }
    await pruneMissing(result);
    lastResult = result;
    console.log("[scan] complete:", result);
    return result;
  } finally {
    scanning = false;
  }
}
