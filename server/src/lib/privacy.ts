// Per-user privacy flags (shareActivity / allowListenAlong), cached in memory —
// they're read on hot paths (friends list, every heartbeat, listen-along polls).
// The PATCH route writes through `setPrivacy`, so the cache stays exact for
// changes made here; the TTL only bounds staleness from out-of-band DB edits.
import { prisma } from "./prisma.js";

export interface Privacy {
  shareActivity: boolean;
  allowListenAlong: boolean;
}

const TTL_MS = 5 * 60_000;
const cache = new Map<string, { p: Privacy; at: number }>();

export function rememberPrivacy(userId: string, p: Privacy): void {
  cache.set(userId, {
    p: { shareActivity: p.shareActivity, allowListenAlong: p.allowListenAlong },
    at: Date.now(),
  });
}

/** A user's privacy flags, or null if the user doesn't exist. */
export async function getPrivacy(userId: string): Promise<Privacy | null> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.p;
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { shareActivity: true, allowListenAlong: true },
  });
  if (!u) {
    cache.delete(userId); // don't cache misses (unbounded ids)
    return null;
  }
  rememberPrivacy(userId, u);
  return u;
}

/** Persist + cache a privacy change; returns the updated pair. */
export async function setPrivacy(userId: string, patch: Partial<Privacy>): Promise<Privacy> {
  const u = await prisma.user.update({
    where: { id: userId },
    data: patch,
    select: { shareActivity: true, allowListenAlong: true },
  });
  rememberPrivacy(userId, u);
  return u;
}

/** Whether others may follow this user's playback (listen-along). */
export function canListenAlong(p: Privacy | null): boolean {
  return !!p && p.shareActivity && p.allowListenAlong;
}
