// Scrobble forwarding to ListenBrainz and Last.fm, server-side so every client
// gets it. Users connect an account once (routes/scrobbling.ts); afterwards
// "now playing" is sent on POST /library/scrobble and the scrobble itself on
// POST /library/scrobble/complete. Everything here is best-effort: failures are
// logged (never with tokens) and swallowed, and nothing blocks a response.
import { createHash } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { env } from "../lib/env.js";

const LB_API = "https://api.listenbrainz.org/1";
const LASTFM_API = "https://ws.audioscrobbler.com/2.0/";
const TIMEOUT_MS = 10_000;
const CLIENT_NAME = "Relay";

/** Thrown when an upstream service can't be reached or answers unexpectedly. */
export class ScrobbleServiceError extends Error {}

// ---- ListenBrainz ----------------------------------------------------------------

/** The ListenBrainz username for a token, or null when the token is invalid. */
export async function validateListenBrainzToken(token: string): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(`${LB_API}/validate-token`, {
      headers: { Authorization: `Token ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ScrobbleServiceError("ListenBrainz unreachable");
  }
  if (res.status === 400 || res.status === 401) return null;
  if (!res.ok) throw new ScrobbleServiceError(`ListenBrainz HTTP ${res.status}`);
  const j = (await res.json().catch(() => null)) as { valid?: boolean; user_name?: string } | null;
  return j?.valid && typeof j.user_name === "string" ? j.user_name : null;
}

// Usernames aren't stored (only the token is), so they're looked up once and
// remembered in memory for the status endpoint.
const lbNames = new Map<string, { name: string | null; at: number }>();
const LB_NAME_TTL_MS = 6 * 60 * 60_000;

export function rememberListenBrainzName(userId: string, name: string | null): void {
  if (name === null) lbNames.delete(userId);
  else lbNames.set(userId, { name, at: Date.now() });
}

/** Cached ListenBrainz username for a connected user (null if unknown/unreachable). */
export async function listenBrainzName(userId: string, token: string): Promise<string | null> {
  const hit = lbNames.get(userId);
  if (hit && Date.now() - hit.at < LB_NAME_TTL_MS) return hit.name;
  try {
    const name = await validateListenBrainzToken(token);
    lbNames.set(userId, { name, at: Date.now() });
    return name;
  } catch {
    // Unreachable: don't hammer it from every status call.
    lbNames.set(userId, { name: hit?.name ?? null, at: Date.now() - LB_NAME_TTL_MS + 5 * 60_000 });
    return hit?.name ?? null;
  }
}

interface TrackInfo {
  title: string;
  artist: string;
  album: string | null;
  duration: number; // seconds
  mbRecordingId: string | null;
}

async function submitListenBrainz(
  userId: string,
  token: string,
  t: TrackInfo,
  listenedAt: Date | null,
): Promise<void> {
  const additional_info: Record<string, unknown> = {
    media_player: CLIENT_NAME,
    submission_client: CLIENT_NAME,
  };
  if (t.duration > 0) additional_info.duration_ms = Math.round(t.duration * 1000);
  if (t.mbRecordingId) additional_info.recording_mbid = t.mbRecordingId;
  const track_metadata: Record<string, unknown> = {
    artist_name: t.artist,
    track_name: t.title,
    additional_info,
  };
  if (t.album) track_metadata.release_name = t.album;
  const body = listenedAt
    ? {
        listen_type: "single",
        payload: [{ listened_at: Math.floor(listenedAt.getTime() / 1000), track_metadata }],
      }
    : { listen_type: "playing_now", payload: [{ track_metadata }] };

  const res = await fetch(`${LB_API}/submit-listens`, {
    method: "POST",
    headers: { Authorization: `Token ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 401) {
    // Token revoked on ListenBrainz: disconnect so the UI shows it.
    await prisma.user
      .updateMany({ where: { id: userId, listenBrainzToken: token }, data: { listenBrainzToken: null } })
      .catch(() => {});
    rememberListenBrainzName(userId, null);
    throw new Error("token rejected (disconnected)");
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

// ---- Last.fm -----------------------------------------------------------------------

export function lastfmAvailable(): boolean {
  return !!(env.lastfmApiKey && env.lastfmApiSecret);
}

/** api_sig: md5 of the params sorted by name as name+value pairs, then the secret.
 *  `format` and `callback` are not part of the signature. */
function lastfmSign(params: Record<string, string>): string {
  const base = Object.keys(params)
    .filter((k) => k !== "format" && k !== "callback")
    .sort()
    .map((k) => `${k}${params[k]}`)
    .join("");
  return createHash("md5").update(base + env.lastfmApiSecret, "utf8").digest("hex");
}

type LastfmResult = { ok: true; data: Record<string, unknown> } | { ok: false; code: number };

async function lastfmCall(params: Record<string, string>, post: boolean): Promise<LastfmResult> {
  const all: Record<string, string> = { ...params, api_key: env.lastfmApiKey };
  all.api_sig = lastfmSign(all);
  all.format = "json";
  const qs = new URLSearchParams(all);
  let res: Response;
  try {
    res = post
      ? await fetch(LASTFM_API, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: qs,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        })
      : await fetch(`${LASTFM_API}?${qs}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new ScrobbleServiceError("Last.fm unreachable");
  }
  const j = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (j && typeof j.error === "number") return { ok: false, code: j.error };
  if (!res.ok || !j) throw new ScrobbleServiceError(`Last.fm HTTP ${res.status}`);
  return { ok: true, data: j };
}

/** Step 1 of the Last.fm web auth flow: a request token for the user to approve. */
export async function lastfmGetToken(): Promise<string> {
  const r = await lastfmCall({ method: "auth.getToken" }, false);
  if (!r.ok || typeof r.data.token !== "string") {
    throw new ScrobbleServiceError(`Last.fm auth.getToken failed${r.ok ? "" : ` (error ${r.code})`}`);
  }
  return r.data.token;
}

export function lastfmAuthUrl(token: string): string {
  return `https://www.last.fm/api/auth/?api_key=${encodeURIComponent(env.lastfmApiKey)}&token=${encodeURIComponent(token)}`;
}

/** Step 2: exchange an approved token for a session, or null if not approved yet. */
export async function lastfmGetSession(token: string): Promise<{ name: string; key: string } | null> {
  const r = await lastfmCall({ method: "auth.getSession", token }, false);
  if (!r.ok) {
    // 14 = not yet authorized, 15 = expired, 4 = invalid token.
    if (r.code === 14 || r.code === 15 || r.code === 4) return null;
    throw new ScrobbleServiceError(`Last.fm auth.getSession error ${r.code}`);
  }
  const s = r.data.session as { name?: unknown; key?: unknown } | undefined;
  if (typeof s?.name !== "string" || typeof s?.key !== "string") return null;
  return { name: s.name, key: s.key };
}

async function submitLastfm(userId: string, sk: string, t: TrackInfo, startedAt: Date | null) {
  const params: Record<string, string> = {
    method: startedAt ? "track.scrobble" : "track.updateNowPlaying",
    artist: t.artist,
    track: t.title,
    sk,
  };
  if (t.album) params.album = t.album;
  if (t.duration > 0) params.duration = String(Math.round(t.duration));
  if (t.mbRecordingId) params.mbid = t.mbRecordingId;
  if (startedAt) params.timestamp = String(Math.floor(startedAt.getTime() / 1000));
  const r = await lastfmCall(params, true);
  if (!r.ok) {
    if (r.code === 9) {
      // Invalid session key (access revoked on Last.fm): disconnect.
      await prisma.user
        .updateMany({
          where: { id: userId, lastfmSessionKey: sk },
          data: { lastfmSessionKey: null, lastfmUsername: null },
        })
        .catch(() => {});
      throw new Error("session rejected (disconnected)");
    }
    throw new Error(`error ${r.code}`);
  }
}

// ---- Forwarding ----------------------------------------------------------------------

async function forward(userId: string, trackId: string, startedAt: Date | null): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { listenBrainzToken: true, lastfmSessionKey: true },
  });
  const lb = user?.listenBrainzToken;
  const lfm = lastfmAvailable() ? user?.lastfmSessionKey : null;
  if (!lb && !lfm) return;
  const track = await prisma.track.findUnique({
    where: { id: trackId },
    select: {
      title: true,
      duration: true,
      mbRecordingId: true,
      artist: { select: { name: true } },
      album: { select: { title: true } },
    },
  });
  if (!track) return;
  const album = track.album?.title?.trim();
  const info: TrackInfo = {
    title: track.title,
    artist: track.artist?.name ?? "Unknown Artist",
    album: album && album.toLowerCase() !== "unknown album" ? album : null,
    duration: track.duration || 0,
    mbRecordingId: track.mbRecordingId || null,
  };
  // Both services ignore listens of tracks under 30 seconds.
  if (startedAt && info.duration > 0 && info.duration < 30) return;
  const kind = startedAt ? "scrobble" : "now playing";
  await Promise.all([
    lb &&
      submitListenBrainz(userId, lb, info, startedAt).catch((e) =>
        console.warn(`[scrobble] ListenBrainz ${kind} failed for user ${userId}:`, (e as Error).message),
      ),
    lfm &&
      submitLastfm(userId, lfm, info, startedAt).catch((e) =>
        console.warn(`[scrobble] Last.fm ${kind} failed for user ${userId}:`, (e as Error).message),
      ),
  ]);
}

/** Fire-and-forget "now playing" to the user's connected services. */
export function forwardNowPlaying(userId: string, trackId: string): void {
  forward(userId, trackId, null).catch((e) =>
    console.warn("[scrobble] now playing failed:", (e as Error).message),
  );
}

/** Fire-and-forget scrobble (a completed listen that started at `startedAt`). */
export function forwardScrobble(userId: string, trackId: string, startedAt: Date): void {
  forward(userId, trackId, startedAt).catch((e) =>
    console.warn("[scrobble] scrobble failed:", (e as Error).message),
  );
}
