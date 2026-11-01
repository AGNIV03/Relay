// Shared list ordering: per-list track sort (remembered in localStorage), the
// per-playlist Shuffle preference, and a seeded shuffle for "random" orders that
// must stay stable across re-renders.
import type { Track } from "./types";

/** Ordering for a playlist's tracks. `custom` is the playlist's own order. */
export type TrackOrder = "custom" | "title" | "artist" | "album" | "added" | "duration";

export const TRACK_ORDER_LABELS: Record<TrackOrder, string> = {
  custom: "Playlist order",
  title: "Title",
  artist: "Artist",
  album: "Album",
  added: "Date added",
  duration: "Length",
};

export interface SortState<O extends string> {
  order: O;
  asc: boolean;
}

/** Picking the active order again flips its direction; a new order starts ascending. */
export function pickSort<O extends string>(s: SortState<O>, o: O): SortState<O> {
  return o === s.order ? { order: o, asc: !s.asc } : { order: o, asc: true };
}

const lower = (v?: string | null) => (v ?? "").toLowerCase();

/** Sort `tracks` by `order` (stable copy). `addedAt` maps trackId → when it was
 *  added to this list (for "added"; falls back to the track's library date). */
export function sortTracks(
  tracks: Track[],
  order: TrackOrder,
  asc: boolean,
  addedAt?: Map<string, string | undefined>,
): Track[] {
  if (order === "custom") return asc ? [...tracks] : [...tracks].reverse();
  const cmp = (a: Track, b: Track): number => {
    switch (order) {
      case "title":
        return lower(a.title).localeCompare(lower(b.title));
      case "artist":
        return lower(a.artist?.name).localeCompare(lower(b.artist?.name));
      case "album":
        return lower(a.album?.title).localeCompare(lower(b.album?.title));
      case "added": {
        const x = addedAt?.get(a.id) ?? a.createdAt ?? "";
        const y = addedAt?.get(b.id) ?? b.createdAt ?? "";
        return x < y ? -1 : x > y ? 1 : 0;
      }
      case "duration":
        return (a.duration || 0) - (b.duration || 0);
      default:
        return 0;
    }
  };
  return tracks
    .map((t, i) => ({ t, i }))
    .sort((p, q) => {
      const c = cmp(p.t, q.t);
      return c !== 0 ? (asc ? c : -c) : p.i - q.i; // stable
    })
    .map((e) => e.t);
}

const ORDERS: TrackOrder[] = ["custom", "title", "artist", "album", "added", "duration"];

/** Remembered per-list sort, stored as `sort_<key>` = `<order>:<asc|desc>`. */
export function loadTrackSort(key: string): SortState<TrackOrder> {
  try {
    const raw = localStorage.getItem(`sort_${key}`);
    if (raw) {
      const [o, dir] = raw.split(":");
      return { order: ORDERS.includes(o as TrackOrder) ? (o as TrackOrder) : "custom", asc: dir !== "desc" };
    }
  } catch {
    /* storage unavailable */
  }
  return { order: "custom", asc: true };
}

export function saveTrackSort(key: string, s: SortState<TrackOrder>) {
  try {
    localStorage.setItem(`sort_${key}`, `${s.order}:${s.asc ? "asc" : "desc"}`);
  } catch {
    /* ignore */
  }
}

/** A list's remembered Shuffle toggle (`pl_shuffle_<id>`; Liked Songs uses "liked"). */
export function loadShufflePref(key: string): boolean {
  try {
    return localStorage.getItem(`pl_shuffle_${key}`) === "true";
  } catch {
    return false;
  }
}

export function saveShufflePref(key: string, on: boolean) {
  try {
    localStorage.setItem(`pl_shuffle_${key}`, String(on));
  } catch {
    /* ignore */
  }
}

/** Fisher–Yates on a copy, driven by a seeded PRNG (mulberry32) so a "random"
 *  order stays the same for a given seed. */
export function seededShuffle<T>(arr: T[], seed: number): T[] {
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Unseeded shuffled copy (for one-off actions like "Add to queue, shuffled"). */
export function shuffled<T>(arr: T[]): T[] {
  return seededShuffle(arr, Math.floor(Math.random() * 2 ** 32));
}
