// Musixmatch translated lyrics (the same source Spotify uses) via its unofficial
// no-key "web-desktop" API — a TypeScript port of what the `syncedlyrics` library
// does. Used to upgrade the machine-translated lyrics with human/crowd
// translations that are matched line-by-line to a synced (LRC) subtitle.
//
// Best-effort and ToS-gray: if anything fails (token/captcha/rate-limit/no match)
// we return null and the caller falls back to the Google machine translation, so
// the app never breaks. We deliberately only return a result when we have BOTH a
// synced subtitle AND a real translation, and only when the matched track looks
// like the song we asked for (a wrong match would replace good lyrics).

import { lrcToPlain } from "./lyrics.service.js";

const BASE = "https://apic-desktop.musixmatch.com/ws/1.1/";
const APP_ID = "web-desktop-app-v1.0";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/123.0 Safari/537.36";

export interface MxmResult {
  syncedLrc: string; // LRC subtitle (the lyrics we'll store + align the translation to)
  translatedText: string; // one line per non-empty lrcToPlain(syncedLrc) line, in order
  lang: string | null; // detected source language (script-based)
}

// --- usertoken + cookie are cached process-wide (the token lasts ~10 min). ---
let tokenCache: { token: string; at: number } | null = null;
let cookie = "";
const TOKEN_TTL_MS = 9 * 60 * 1000;

/** Normalise a lyric line for matching (case/space/punct-insensitive). */
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Cheap offline source-language guess from the script (covers the cases where a
 *  translation matters most). Returns null for Latin scripts (label just omitted). */
function detectScriptLang(text: string): string | null {
  if (/[぀-ゟ゠-ヿ]/.test(text)) return "ja"; // kana
  if (/[가-힯]/.test(text)) return "ko"; // hangul
  if (/[Ѐ-ӿ]/.test(text)) return "ru"; // cyrillic
  if (/[؀-ۿ]/.test(text)) return "ar"; // arabic
  if (/[一-鿿]/.test(text)) return "zh"; // CJK (after kana check)
  return null;
}

async function mxmGet(
  endpoint: string,
  params: Record<string, string>,
  withToken: boolean,
): Promise<unknown> {
  const url = new URL(BASE + endpoint);
  url.searchParams.set("app_id", APP_ID);
  url.searchParams.set("format", "json");
  url.searchParams.set("t", String(Date.now()));
  if (withToken && tokenCache) url.searchParams.set("usertoken", tokenCache.token);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, ...(cookie ? { Cookie: cookie } : {}) },
      signal: controller.signal,
    });
    const setCookies = res.headers.getSetCookie?.() ?? [];
    if (setCookies.length) cookie = setCookies.map((c) => c.split(";")[0]).join("; ");
    if (!res.ok) throw new Error(`mxm ${endpoint} ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function body(json: unknown): any {
  return (json as any)?.message?.body ?? null;
}
function statusCode(json: unknown): number {
  return (json as any)?.message?.header?.status_code ?? 0;
}

async function getToken(): Promise<string | null> {
  if (tokenCache && Date.now() - tokenCache.at < TOKEN_TTL_MS) return tokenCache.token;
  // Musixmatch gates this with a "captcha" 401 for the first few calls; the seeded
  // cookie clears it after several retries. Once obtained the token is cached ~10
  // min, so only the first lookup in a window pays this cost.
  for (let attempt = 0; attempt < 7; attempt++) {
    const json = await mxmGet("token.get", { user_language: "en" }, false).catch(() => null);
    const token = body(json)?.user_token as string | undefined;
    if (token && token.length > 20) {
      tokenCache = { token, at: Date.now() };
      return token;
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  return null;
}

/** Resolve the Musixmatch track_id via its fuzzy artist+title matcher, but only
 *  accept it when the returned track's artist AND title clearly match what we
 *  asked for and it actually has a synced subtitle — so we never replace a song's
 *  lyrics with a different (wrong) track. Returns null otherwise. */
async function resolveTrackId(artist: string, title: string): Promise<number | null> {
  const json = await mxmGet("matcher.track.get", { q_artist: artist, q_track: title }, true);
  const track = body(json)?.track as any;
  if (!track?.track_id || !track.has_subtitles) return null;

  const wantTitle = norm(title);
  const wantArtist = norm(artist);
  const tName = norm(String(track.track_name ?? ""));
  const aName = norm(String(track.artist_name ?? ""));
  // Title: equal, or one contains the other (covers "… - movie ver." style suffixes).
  const titleOk =
    !!wantTitle && (tName === wantTitle || tName.includes(wantTitle) || wantTitle.includes(tName));
  // Artist: overlap in either direction (covers "feat." additions). Required so a
  // loose fuzzy match to a same-titled different song is rejected.
  const artistOk =
    !!wantArtist && (aName.includes(wantArtist) || wantArtist.includes(aName));
  if (!titleOk || !artistOk) return null;
  return Number(track.track_id);
}

/**
 * Fetch a Musixmatch synced subtitle + line-aligned translation for a song.
 * Returns null unless BOTH exist and at least one line actually translated.
 */
export async function fetchMusixmatchTranslated(
  artist: string,
  title: string,
  target = "en",
): Promise<MxmResult | null> {
  if (!artist || !title) return null;
  try {
    if (!(await getToken())) return null;

    const trackId = await resolveTrackId(artist, title);
    if (!trackId) return null;
    const id = String(trackId);

    // Synced subtitle (LRC).
    const subJson = await mxmGet(
      "track.subtitle.get",
      { track_id: id, subtitle_format: "lrc" },
      true,
    );
    const syncedLrc = body(subJson)?.subtitle?.subtitle_body as string | undefined;
    if (!syncedLrc || !syncedLrc.trim()) return null;

    // Crowd translations, matched per original subtitle line.
    const trJson = await mxmGet(
      "crowd.track.translations.get",
      {
        track_id: id,
        subtitle_format: "lrc",
        translation_fields_set: "minimal",
        selected_language: target,
      },
      true,
    );
    if (statusCode(trJson) !== 200) return null;
    const items = body(trJson)?.translations_list as Array<{ translation: any }> | undefined;
    if (!items?.length) return null;

    const map = new Map<string, string>();
    for (const it of items) {
      const orig = it?.translation?.subtitle_matched_line;
      const tr = it?.translation?.description;
      if (typeof orig === "string" && typeof tr === "string") map.set(norm(orig), tr);
    }
    if (!map.size) return null;

    // Build the translation aligned to lrcToPlain(syncedLrc): exactly one entry per
    // non-empty original line, in order (blank where no translation exists). This is
    // the contract both clients rely on to zip translations under each lyric line.
    const origLines = lrcToPlain(syncedLrc).split("\n");
    const translatedLines = origLines.map((l) => map.get(norm(l)) ?? "");
    if (translatedLines.every((x) => !x.trim())) return null; // nothing matched → bail

    return {
      syncedLrc,
      translatedText: translatedLines.join("\n"),
      lang: detectScriptLang(origLines.join(" ")),
    };
  } catch {
    return null; // any failure → caller falls back to Google MT
  }
}
