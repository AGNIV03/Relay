import type { Track } from "@/lib/types";

/** GET /api/library/stats/wrapped?year=YYYY */
export interface RewindStats {
  year: number;
  hasData: boolean;
  totalPlays: number;
  totalMinutes: number;
  distinctTracks: number;
  distinctArtists: number;
  topTracks: { id: string; title: string; artist: string; playCount: number }[];
  topArtists: { name: string; count: number; trackId: string | null }[];
  topGenres: { name: string; count: number; trackId: string | null }[];
  monthMinutes: number[];
  peakMonth: number;
  peakMonthTrackId: string | null;
}

/** Stats plus the hydrated tracks they reference (id -> Track, for audio + metadata). */
export interface RewindData {
  stats: RewindStats;
  tracks: Record<string, Track>;
}
