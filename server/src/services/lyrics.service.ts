// Lyrics lookup via LRCLIB (https://lrclib.net) — free, no API key, returns
// time-synced (.lrc) lyrics matched by track signature. Used at scan/upload time
// and on-demand. We store the synced LRC for karaoke-style highlighting plus a
// plain-text fallback.

export interface LyricsResult {
  plain: string | null;
  synced: string | null;
  /** true if the lookup completed (even if nothing was found) so we don't refetch forever */
  checked: boolean;
}

const UA = "StreamSelfHosted/1.0 (+https://github.com/AGNIV03/stream)";

export async function fetchLyrics(
  artist: string,
  title: string,
  album: string | null | undefined,
  durationSec: number | null | undefined,
): Promise<LyricsResult> {
  if (!artist || !title) return { plain: null, synced: null, checked: true };
  const params = new URLSearchParams({ artist_name: artist, track_name: title });
  if (album) params.set("album_name", album);
  if (durationSec && durationSec > 0) params.set("duration", String(Math.round(durationSec)));

  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 8000);
    let res = await fetch(`https://lrclib.net/api/get?${params}`, {
      headers: { "User-Agent": UA },
      signal: controller.signal,
    });
    // Fall back to fuzzy search if the exact signature match misses.
    if (res.status === 404) {
      const sp = new URLSearchParams({ q: `${artist} ${title}` });
      res = await fetch(`https://lrclib.net/api/search?${sp}`, {
        headers: { "User-Agent": UA },
        signal: controller.signal,
      });
      clearTimeout(t);
      if (!res.ok) return { plain: null, synced: null, checked: res.status === 404 };
      const list = (await res.json()) as Array<{ plainLyrics?: string; syncedLyrics?: string }>;
      const hit = list.find((x) => x.syncedLyrics) ?? list[0];
      if (!hit) return { plain: null, synced: null, checked: true };
      return { plain: hit.plainLyrics ?? null, synced: hit.syncedLyrics ?? null, checked: true };
    }
    clearTimeout(t);
    if (!res.ok) return { plain: null, synced: null, checked: false }; // transient — retry later
    const data = (await res.json()) as { plainLyrics?: string; syncedLyrics?: string };
    return { plain: data.plainLyrics ?? null, synced: data.syncedLyrics ?? null, checked: true };
  } catch {
    return { plain: null, synced: null, checked: false }; // network error — retry later
  }
}
