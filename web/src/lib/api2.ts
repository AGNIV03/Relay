// Endpoint wrappers for this round's features, built on the shared `api` helper
// (lib/api.ts handles auth headers + refresh).
import { API_URL, api } from "./api";
import type { User } from "./types";
import type {
  AdminDashboard,
  ImportResult,
  ImportSource,
  InviteCheck,
  InviteCode,
  ScrobblingStatus,
  SearchResults,
} from "./types2";

const enc = encodeURIComponent;

// ---- Admin ----
export const adminApi = {
  dashboard: () => api.get<AdminDashboard>("/api/admin/dashboard"),
  invites: () => api.get<InviteCode[]>("/api/admin/invites"),
  createInvite: (body: {
    role?: "USER" | "ADMIN";
    maxUses?: number;
    expiresInDays?: number | null;
    note?: string;
  }) => api.post<InviteCode>("/api/admin/invites", body),
  revokeInvite: (id: string) => api.del<void>(`/api/admin/invites/${enc(id)}`),
};

// ---- Invites + registration (public) ----
export interface AuthResponse {
  accessToken: string;
  refreshToken: string;
  user: User;
}

/** Plain fetch (no stored-token header / refresh): these run signed out. */
async function publicRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let message = res.status === 429 ? "Too many attempts, try again later" : res.statusText;
    try {
      message = (await res.json()).error ?? message;
    } catch {
      /* ignore */
    }
    throw new Error(message || `Request failed (${res.status})`);
  }
  return res.json();
}

export const authApi = {
  checkInvite: (code: string) => publicRequest<InviteCheck>(`/api/auth/invite/${enc(code)}`),
  register: (code: string, username: string, password: string) =>
    publicRequest<AuthResponse>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ code, username, password }),
    }),
};

// ---- Scrobbling accounts ----
export const scrobblingApi = {
  status: () => api.get<ScrobblingStatus>("/api/scrobbling"),
  connectListenBrainz: (token: string) =>
    api.post<ScrobblingStatus>("/api/scrobbling/listenbrainz", { token }),
  disconnectListenBrainz: () => api.del<ScrobblingStatus>("/api/scrobbling/listenbrainz"),
  startLastfm: () => api.post<{ authUrl: string; token: string }>("/api/scrobbling/lastfm/start"),
  completeLastfm: (token: string) =>
    api.post<ScrobblingStatus>("/api/scrobbling/lastfm/complete", { token }),
  disconnectLastfm: () => api.del<ScrobblingStatus>("/api/scrobbling/lastfm"),
};

// ---- Playlists ----
export const playlistApi = {
  reorder: (id: string, trackIds: string[]) =>
    api.patch<void>(`/api/playlists/${enc(id)}/tracks/order`, { trackIds }),
  removeMany: (id: string, trackIds: string[]) =>
    api.post<{ removed: number }>(`/api/playlists/${enc(id)}/tracks/remove`, { trackIds }),
  addMany: (id: string, trackIds: string[]) =>
    api.post<{ added: number }>(`/api/playlists/${enc(id)}/tracks/bulk`, { trackIds }),
  import: (body: { name: string; source: ImportSource; content?: string; url?: string }) =>
    api.post<ImportResult>("/api/playlists/import", body),
};

// ---- Search ----
export async function searchAll(q: string): Promise<SearchResults> {
  const r = await api.get<Partial<SearchResults>>(`/api/search?q=${enc(q)}`);
  // Older servers omit `playlists`.
  return {
    tracks: r.tracks ?? [],
    albums: r.albums ?? [],
    artists: r.artists ?? [],
    playlists: r.playlists ?? [],
  };
}
