// Disk usage for the admin dashboard. Walking the whole library is slow on big
// collections, so directory sizes are cached for a few minutes and refreshed in
// the background (stale-while-revalidate): only the very first call waits.
import { promises as fs } from "node:fs";
import path from "node:path";
import { env } from "../lib/env.js";

const CACHE_MS = 5 * 60_000;

export interface StorageStats {
  musicBytes: number;
  coversBytes: number;
  diskFreeBytes: number;
  diskTotalBytes: number;
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0; // missing / unreadable
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(full);
    else if (e.isFile()) total += await fs.stat(full).then((s) => s.size, () => 0);
  }
  return total;
}

async function diskStats(): Promise<{ free: number; total: number }> {
  try {
    const s = await fs.statfs(env.musicPath);
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch {
    return { free: 0, total: 0 };
  }
}

async function compute(): Promise<StorageStats> {
  const [musicBytes, coversBytes, disk] = await Promise.all([
    dirSize(env.musicPath),
    dirSize(path.join(env.dataPath, "covers")),
    diskStats(),
  ]);
  return { musicBytes, coversBytes, diskFreeBytes: disk.free, diskTotalBytes: disk.total };
}

let cached: { at: number; value: StorageStats } | null = null;
let refreshing: Promise<StorageStats> | null = null;

function refresh(): Promise<StorageStats> {
  refreshing ??= compute()
    .then((value) => {
      cached = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

/** Storage stats; directory sizes may be up to ~5 minutes old (free space is live). */
export async function getStorageStats(): Promise<StorageStats> {
  if (!cached) return refresh();
  if (Date.now() - cached.at > CACHE_MS) void refresh().catch(() => {});
  const disk = await diskStats();
  return { ...cached.value, diskFreeBytes: disk.free, diskTotalBytes: disk.total };
}
