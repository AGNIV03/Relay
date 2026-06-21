export type Role = "ADMIN" | "USER";

export interface User {
  id: string;
  username: string;
  role: Role;
  createdAt?: string;
}

export interface Artist {
  id: string;
  name: string;
  _count?: { albums: number; tracks: number };
  albums?: Album[];
}

export interface Album {
  id: string;
  title: string;
  year?: number | null;
  coverPath?: string | null;
  artist?: Artist;
  artistId?: string;
  tracks?: Track[];
  _count?: { tracks: number };
}

export interface Track {
  id: string;
  title: string;
  duration: number;
  trackNo?: number | null;
  discNo?: number | null;
  genre?: string | null;
  format?: string | null;
  bitrate?: number | null;
  size?: number;
  album?: Album | null;
  artist?: Artist;
  artistId?: string;
  createdAt?: string;
  playCount?: number;
  uploader?: { username: string } | null;
}

export interface Friend {
  id: string;
  username: string;
  online: boolean;
  playing: boolean;
  track?: Track | null;
}

export interface HostActivity {
  trackId: string | null;
  track?: Track | null;
  positionMs: number;
  playing: boolean;
  updatedAt?: number | string | null;
  online: boolean;
}

export interface WrappedStats {
  totalPlays: number;
  totalMinutes: number;
  distinctTracks: number;
  topArtists: { name: string; count: number }[];
  topGenres: { name: string; count: number }[];
  topTracks: { id: string; title: string; artist: string; playCount: number }[];
}

export interface Lyrics {
  synced: string | null;
  plain: string | null;
}

export interface Playlist {
  id: string;
  name: string;
  createdAt?: string;
  system?: boolean; // true for the permanent "Liked Songs" playlist
  _count?: { tracks: number };
  tracks?: { id: string; position: number; addedAt?: string; track: Track }[];
}

export interface Stats {
  tracks: number;
  albums: number;
  artists: number;
  users: number;
  playlists: number;
  totalDurationSec: number;
  totalSizeBytes: number;
}

export interface ScanStatus {
  scanning: boolean;
  lastResult: {
    scanned: number;
    added: number;
    updated: number;
    removed: number;
    errors: number;
  } | null;
}
