// In-memory presence: each user's latest playback state, for the friends panel
// and "listen along". Ephemeral (cleared on restart) — that's fine for presence.
//
// Each activity carries a `version` that bumps on every heartbeat so listen-along
// followers can long-poll (wait for the host's next change instead of busy-polling
// every few seconds) for tight, low-latency sync.

export interface Activity {
  trackId: string | null;
  positionMs: number;
  playing: boolean;
  updatedAt: number; // epoch ms of the last heartbeat
  version: number; // bumps on every change — long-poll cursor
}

const presence = new Map<string, Activity>();
const waiters = new Map<string, Set<() => void>>(); // userId -> long-poll wakeups

export const ONLINE_WINDOW_MS = 35_000;

function wake(userId: string) {
  const set = waiters.get(userId);
  if (!set) return;
  for (const fn of [...set]) fn(); // each callback removes itself
}

export function setActivity(userId: string, a: Omit<Activity, "updatedAt" | "version">): void {
  const prev = presence.get(userId);
  presence.set(userId, { ...a, updatedAt: Date.now(), version: (prev?.version ?? 0) + 1 });
  wake(userId);
}

export function getActivity(userId: string): Activity | undefined {
  return presence.get(userId);
}

export function isOnline(a: Activity | undefined): boolean {
  return !!a && Date.now() - a.updatedAt < ONLINE_WINDOW_MS;
}

/** Register a long-poll wakeup for a user's activity. Returns an unsubscribe fn. */
export function subscribeActivity(userId: string, cb: () => void): () => void {
  let set = waiters.get(userId);
  if (!set) {
    set = new Set();
    waiters.set(userId, set);
  }
  set.add(cb);
  return () => {
    const s = waiters.get(userId);
    if (s) {
      s.delete(cb);
      if (s.size === 0) waiters.delete(userId);
    }
  };
}
