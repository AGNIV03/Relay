// Types for this round's endpoints (kept apart from types.ts, which W1 owns).
import type { Album, Artist, Role, Track } from "./types";

/** GET /api/admin/invites (with the creator's name). */
export interface InviteCode {
  id: string;
  code: string;
  role: Role;
  maxUses: number;
  uses: number;
  note?: string | null;
  expiresAt?: string | null;
  revokedAt?: string | null;
  createdAt: string;
  createdBy?: { username: string } | null;
}

export interface DashboardUser {
  id: string;
  username: string;
  role: Role;
  createdAt: string;
  lastSeenAt: string | null;
  online: boolean;
  plays7d: number;
  uploads: number;
}

export interface IngestRejection {
  id: string;
  name: string;
  reason: string;
  source: "upload" | "admin" | "scan" | string;
  username: string | null;
  createdAt: string;
}

/** GET /api/admin/dashboard (web only). */
export interface AdminDashboard {
  storage: {
    musicBytes: number;
    coversBytes: number;
    diskFreeBytes: number;
    diskTotalBytes: number;
  };
  counts: {
    tracks: number;
    albums: number;
    artists: number;
    users: number;
    playlists: number;
    plays24h: number;
    plays7d: number;
    totalMinutes: number;
  };
  scan: {
    running: boolean;
    lastResult: {
      scanned: number;
      added: number;
      updated: number;
      removed: number;
      errors: number;
    } | null;
  };
  users: DashboardUser[];
  rejections: IngestRejection[];
  autotag: { enabled: boolean };
  invites: { active: number };
}

/** GET /api/auth/invite/:code */
export interface InviteCheck {
  valid: boolean;
  role?: Role;
}

/** GET /api/scrobbling (and every scrobbling mutation). */
export interface ScrobblingStatus {
  listenbrainz: { connected: boolean; username: string | null };
  lastfm: { connected: boolean; username: string | null; available: boolean };
}

export type ImportSource = "m3u" | "text" | "spotify";

/** POST /api/playlists/import */
export interface ImportResult {
  playlistId: string;
  matched: number;
  total: number;
  unmatched: string[];
}

export interface SearchPlaylist {
  id: string;
  name: string;
  trackCount: number;
  ownerName: string;
}

/** GET /api/search?q= */
export interface SearchResults {
  tracks: Track[];
  albums: Album[];
  artists: Artist[];
  playlists: SearchPlaylist[];
}
