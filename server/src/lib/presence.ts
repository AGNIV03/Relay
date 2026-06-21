// In-memory presence: each user's latest playback state, for the friends panel
// and "listen along". Ephemeral (cleared on restart) — that's fine for presence.

export interface Activity {
  trackId: string | null;
  positionMs: number;
  playing: boolean;
  updatedAt: number; // epoch ms of the last heartbeat
}

const presence = new Map<string, Activity>();

export const ONLINE_WINDOW_MS = 35_000;

export function setActivity(userId: string, a: Omit<Activity, "updatedAt">): void {
  presence.set(userId, { ...a, updatedAt: Date.now() });
}

export function getActivity(userId: string): Activity | undefined {
  return presence.get(userId);
}

export function isOnline(a: Activity | undefined): boolean {
  return !!a && Date.now() - a.updatedAt < ONLINE_WINDOW_MS;
}
