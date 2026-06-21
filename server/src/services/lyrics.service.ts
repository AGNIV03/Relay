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

/** Strip LRC timestamp/metadata tags → ordered non-empty plain lines (one per line). */
export function lrcToPlain(lrc: string): string {
  return lrc
    .split("\n")
    .map((l) => l.replace(/\[[^\]]*\]/g, "").trim())
    .filter((l) => l.length > 0)
    .join("\n");
}

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

    // 1. Exact signature match.
    let exactPlain: string | null = null;
    const res = await fetch(`https://lrclib.net/api/get?${params}`, {
      headers: { "User-Agent": UA },
      signal: controller.signal,
    });
    if (res.ok) {
      const data = (await res.json()) as { plainLyrics?: string; syncedLyrics?: string };
      if (data.syncedLyrics) {
        clearTimeout(t);
        return { plain: data.plainLyrics ?? null, synced: data.syncedLyrics, checked: true };
      }
      exactPlain = data.plainLyrics ?? null;
    } else if (res.status !== 404) {
      clearTimeout(t);
      return { plain: null, synced: null, checked: false }; // transient — retry later
    }

    // 2. No synced from the exact match — search for a version that HAS synced
    //    lyrics (many tracks only expose synced under a slightly different match).
    const sp = new URLSearchParams({ q: `${artist} ${title}` });
    const sres = await fetch(`https://lrclib.net/api/search?${sp}`, {
      headers: { "User-Agent": UA },
      signal: controller.signal,
    });
    clearTimeout(t);
    if (!sres.ok) {
      // Keep any plain we already found.
      return { plain: exactPlain, synced: null, checked: true };
    }
    const list = (await sres.json()) as Array<{ plainLyrics?: string; syncedLyrics?: string }>;
    const synced = list.find((x) => x.syncedLyrics);
    if (synced) {
      return { plain: synced.plainLyrics ?? exactPlain, synced: synced.syncedLyrics!, checked: true };
    }
    const plain = exactPlain ?? list.find((x) => x.plainLyrics)?.plainLyrics ?? null;
    return { plain, synced: null, checked: true };
  } catch {
    return { plain: null, synced: null, checked: false }; // network error — retry later
  }
}
