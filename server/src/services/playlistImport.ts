// Playlist import: parse an M3U file / plain text list / public Spotify playlist
// into (artist, title) entries and fuzzy-match them against the library.
import path from "node:path";
import { prisma } from "../lib/prisma.js";
import { env } from "../lib/env.js";

export interface ImportEntry {
  artist: string | null;
  title: string;
  file?: string; // m3u path line, matched against library file names first
}

/** Thrown with a message that is safe to show to the user. */
export class ImportError extends Error {}

export const MAX_IMPORT_ENTRIES = 5000;

// ---- Parsing ---------------------------------------------------------------

/** Split "Artist - Title" (hyphen, en or em dash). No separator → title only. */
function splitArtistTitle(s: string): { artist: string | null; title: string } {
  const m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(s.trim());
  if (m && m[1].trim() && m[2].trim()) return { artist: m[1].trim(), title: m[2].trim() };
  return { artist: null, title: s.trim() };
}

/** File stem of an m3u path/URL line, minus a leading track number. */
function stemOf(line: string): string {
  let p = line.trim();
  if (/^file:\/\//i.test(p)) p = p.replace(/^file:\/\/\/?/i, "");
  try {
    p = decodeURIComponent(p);
  } catch {
    /* keep as-is */
  }
  const base = p.split(/[\\/]/).pop() ?? p;
  return base.replace(/\.[A-Za-z0-9]{1,5}$/, "");
}

function baseName(line: string): string {
  let p = line.trim();
  if (/^file:\/\//i.test(p)) p = p.replace(/^file:\/\/\/?/i, "");
  try {
    p = decodeURIComponent(p);
  } catch {
    /* keep as-is */
  }
  return (p.split(/[\\/]/).pop() ?? p).toLowerCase();
}

/** M3U / M3U8: `#EXTINF:<secs>,Artist - Title` lines, else the file names. */
export function parseM3u(content: string): ImportEntry[] {
  const out: ImportEntry[] = [];
  let info: { artist: string | null; title: string } | null = null;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      const m = /^#EXTINF:[^,]*,(.*)$/i.exec(line);
      if (m && m[1].trim()) info = splitArtistTitle(m[1]);
      continue;
    }
    if (info) {
      out.push({ ...info, file: line });
    } else {
      const stem = stemOf(line).replace(/^\d{1,3}[\s._-]+/, "");
      if (stem) out.push({ ...splitArtistTitle(stem), file: line });
    }
    info = null;
    if (out.length >= MAX_IMPORT_ENTRIES) break;
  }
  return out;
}

/** One "Artist - Title" (or just "Title") per line. */
export function parseText(content: string): ImportEntry[] {
  const out: ImportEntry[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.replace(/^\s*(\d{1,4}[.)]\s+|[-*•]\s+)/, "").trim();
    if (!line || line.startsWith("#")) continue;
    out.push(splitArtistTitle(line));
    if (out.length >= MAX_IMPORT_ENTRIES) break;
  }
  return out;
}

// ---- Spotify (client-credentials) --------------------------------------------

export function spotifyConfigured(): boolean {
  return !!(env.spotifyClientId && env.spotifyClientSecret);
}

let spotifyToken: { value: string; expiresAt: number } | null = null;

async function spotifyAccessToken(): Promise<string> {
  if (spotifyToken && spotifyToken.expiresAt - 60_000 > Date.now()) return spotifyToken.value;
  const basic = Buffer.from(`${env.spotifyClientId}:${env.spotifyClientSecret}`).toString("base64");
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    console.warn(`[import] Spotify token request failed: HTTP ${res.status}`);
    throw new ImportError("Couldn't connect to Spotify. Please try again later.");
  }
  const j = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!j.access_token) throw new ImportError("Couldn't connect to Spotify. Please try again later.");
  spotifyToken = { value: j.access_token, expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000 };
  return j.access_token;
}

/** Playlist id from an open.spotify.com URL or a spotify:playlist: URI. */
export function spotifyPlaylistId(url: string): string | null {
  const m = /(?:open\.spotify\.com\/(?:[a-z-]+\/)?playlist\/|spotify:playlist:)([A-Za-z0-9]{10,40})/i.exec(
    url.trim(),
  );
  return m ? m[1] : null;
}

type SpotifyPage = {
  next?: string | null;
  items?: Array<{ track?: { name?: string; artists?: Array<{ name?: string }> } | null }>;
};

/** All (artist, title) entries of a public Spotify playlist. */
export async function fetchSpotifyPlaylist(url: string): Promise<ImportEntry[]> {
  const id = spotifyPlaylistId(url);
  if (!id) throw new ImportError("That doesn't look like a Spotify playlist link");
  const token = await spotifyAccessToken();
  const out: ImportEntry[] = [];
  let next: string | null =
    `https://api.spotify.com/v1/playlists/${id}/tracks?limit=100` +
    `&fields=${encodeURIComponent("next,items(track(name,artists(name)))")}`;
  for (let page = 0; next && page < MAX_IMPORT_ENTRIES / 100; page++) {
    // Only follow pagination links back to the Spotify API.
    if (!next.startsWith("https://api.spotify.com/")) break;
    let res: Response;
    try {
      res = await fetch(next, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new ImportError("Couldn't reach Spotify. Please try again later.");
    }
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      throw new ImportError("Couldn't read that Spotify playlist. Make sure it's public.");
    }
    if (!res.ok) {
      console.warn(`[import] Spotify playlist fetch failed: HTTP ${res.status}`);
      throw new ImportError("Couldn't read that Spotify playlist. Please try again later.");
    }
    const j = (await res.json()) as SpotifyPage;
    for (const it of j.items ?? []) {
      const name = it.track?.name?.trim();
      if (!name) continue; // removed track / podcast episode
      const artist = (it.track?.artists ?? []).map((a) => a.name?.trim()).filter(Boolean)[0] ?? null;
      out.push({ artist, title: name });
      if (out.length >= MAX_IMPORT_ENTRIES) return out;
    }
    next = j.next ?? null;
  }
  return out;
}

// ---- Matching ----------------------------------------------------------------

const VERSION_WORDS =
  /\b(remaster(ed)?|live|mono|stereo|version|edit|mix|remix|demo|acoustic|instrumental|single|bonus|deluxe|explicit|clean|radio)\b/;

function basic(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip accents
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Normalized title: no accents/punctuation, no "(Remastered 2011)" / "[Live]"
 *  suffixes, no "feat. X", no " - 2011 Remaster" tails. */
export function normTitle(s: string): string {
  let t = s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  t = t.replace(/\s*[([{][^)\]}]*[)\]}]/g, " "); // bracketed suffixes
  t = t.replace(/\s+(feat\.?|ft\.?|featuring)\s+.*$/, ""); // unbracketed feat.
  const dash = /^(.+?)\s+[-–—]\s+(.+)$/.exec(t);
  if (dash && VERSION_WORDS.test(dash[2])) t = dash[1]; // "Song - 2011 Remaster"
  const out = basic(t);
  return out || basic(s); // a title that was only brackets: keep it whole
}

/** Normalized artist parts ("A feat. B & C" → ["a", "b", "c"]), "the " dropped. */
function artistParts(s: string): string[] {
  const parts = s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/\s*(?:,|;|\/|&|\+|\bx\b|\band\b|\bfeat\.?|\bft\.?|\bfeaturing\b|\bwith\b|\bvs\.?)\s*/)
    .map((p) => basic(p).replace(/^the /, ""))
    .filter(Boolean);
  const whole = basic(s).replace(/^the /, "");
  return whole ? [...new Set([whole, ...parts])] : parts;
}

function artistsMatch(a: string[], b: string[]): boolean {
  for (const x of a) {
    for (const y of b) {
      if (x === y) return true;
      if (x.length >= 4 && y.length >= 4 && (x.includes(y) || y.includes(x))) return true;
    }
  }
  return false;
}

interface LibTrack {
  id: string;
  artist: string[];
}

/** Match entries against the whole library. Returns a track id (or null) per entry. */
export async function matchEntries(entries: ImportEntry[]): Promise<(string | null)[]> {
  const lib = await prisma.track.findMany({
    select: { id: true, title: true, path: true, artist: { select: { name: true } } },
  });
  const byTitle = new Map<string, LibTrack[]>();
  const byFile = new Map<string, string[]>();
  for (const t of lib) {
    const key = normTitle(t.title);
    const arr = byTitle.get(key) ?? [];
    arr.push({ id: t.id, artist: artistParts(t.artist?.name ?? "") });
    byTitle.set(key, arr);
    const base = path.basename(t.path).toLowerCase();
    const ids = byFile.get(base) ?? [];
    ids.push(t.id);
    byFile.set(base, ids);
  }

  const byArtist = (title: string, artist: string): string | null => {
    const cands = byTitle.get(normTitle(title));
    if (!cands) return null;
    const parts = artistParts(artist);
    return cands.find((c) => artistsMatch(parts, c.artist))?.id ?? null;
  };
  const titleOnly = (title: string): string | null => {
    const cands = byTitle.get(normTitle(title));
    return cands && cands.length === 1 ? cands[0].id : null;
  };

  return entries.map((e) => {
    if (e.file) {
      const ids = byFile.get(baseName(e.file));
      if (ids && ids.length === 1) return ids[0];
    }
    if (e.artist) {
      const hit =
        byArtist(e.title, e.artist) ??
        byArtist(e.artist, e.title) ?? // "Title - Artist" lines
        titleOnly(e.title);
      if (hit) return hit;
      return null;
    }
    return titleOnly(e.title);
  });
}

/** Display label for an unmatched entry. */
export function entryLabel(e: ImportEntry): string {
  return e.artist ? `${e.artist} - ${e.title}` : e.title;
}
