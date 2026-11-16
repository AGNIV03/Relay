// Client-side preferences in localStorage: the single reader/writer for the
// settings page and the player (PlayerContext). Mirrors app/lib/settings.dart.

export const SETTINGS_EVENT = "relay-settings";

export interface PlaybackSettings {
  autoplay: boolean;
  normalize: boolean;
  fadeSeconds: number; // 0..12
}

const KEYS = {
  autoplay: "set_autoplay",
  normalize: "set_normalize",
  fadeSeconds: "set_fade_seconds",
  recent: "recent_searches",
} as const;

function read(key: string): string | null {
  try {
    return typeof window === "undefined" ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

/** Unset means the default; "false" / "0" mean off (anything else is on). */
function readBool(key: string, def: boolean): boolean {
  const v = read(key);
  if (v == null) return def;
  return !(v === "false" || v === "0");
}

/** The one reader for playback settings (the settings page and the player). */
export function loadPlaybackSettings(): PlaybackSettings {
  const fade = Number(read(KEYS.fadeSeconds) ?? 0);
  return {
    autoplay: readBool(KEYS.autoplay, true), // default on
    normalize: readBool(KEYS.normalize, true), // default on
    fadeSeconds: Number.isFinite(fade) ? Math.max(0, Math.min(12, Math.round(fade))) : 0,
  };
}

/** Persist one setting and tell the player (same tab) so it applies live. Other
 *  tabs get the native `storage` event. */
export function savePlaybackSetting<K extends keyof PlaybackSettings>(
  key: K,
  value: PlaybackSettings[K],
) {
  if (typeof window === "undefined") return;
  write(KEYS[key], String(value));
  window.dispatchEvent(
    new CustomEvent(SETTINGS_EVENT, { detail: { key: KEYS[key], value: String(value) } }),
  );
}

// ---- Recent searches ----
const RECENT_MAX = 12;

export function loadRecentSearches(): string[] {
  try {
    const v = JSON.parse(read(KEYS.recent) ?? "[]");
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string").slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

function saveRecent(list: string[]) {
  write(KEYS.recent, JSON.stringify(list.slice(0, RECENT_MAX)));
}

/** Most recent first, case-insensitive de-dupe. Returns the new list. */
export function addRecentSearch(q: string): string[] {
  const s = q.trim();
  if (!s) return loadRecentSearches();
  const list = [s, ...loadRecentSearches().filter((x) => x.toLowerCase() !== s.toLowerCase())];
  saveRecent(list);
  return list.slice(0, RECENT_MAX);
}

export function removeRecentSearch(q: string): string[] {
  const list = loadRecentSearches().filter((x) => x !== q);
  saveRecent(list);
  return list;
}

export function clearRecentSearches(): string[] {
  saveRecent([]);
  return [];
}
