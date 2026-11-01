import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { Track } from "@/lib/types";
import type { RewindData, RewindStats } from "./types";

/**
 * Where Rewind lives through the year (mirrors RewindSchedule in the Flutter app):
 *  - Dec 20 to Dec 31: this year's Rewind is featured on Home.
 *  - Jan 1 to Jan 7: last year's Rewind is still on Home.
 *  - Jan 8 to Dec 19: last year's Rewind moves to Profile, where it stays
 *    until the next one appears on Home.
 */
export const RewindSchedule = {
  homeYear(now: Date = new Date()): number | null {
    const m = now.getMonth(); // 0-based
    const d = now.getDate();
    if (m === 11 && d >= 20) return now.getFullYear();
    if (m === 0 && d <= 7) return now.getFullYear() - 1;
    return null;
  },
  profileYear(now: Date = new Date()): number | null {
    return RewindSchedule.homeYear(now) == null ? now.getFullYear() - 1 : null;
  },
};

export function fetchRewindStats(year: number): Promise<RewindStats> {
  return api.get<RewindStats>(`/api/library/stats/wrapped?year=${year}`);
}

/** Stats plus every track they reference. Track lookup failing is fine: the
 *  story still plays, just silently. */
export async function loadRewind(year: number): Promise<RewindData> {
  const stats = await fetchRewindStats(year);
  const ids = new Set<string>();
  for (const t of stats.topTracks ?? []) if (t.id) ids.add(t.id);
  for (const a of stats.topArtists ?? []) if (a.trackId) ids.add(a.trackId);
  for (const g of stats.topGenres ?? []) if (g.trackId) ids.add(g.trackId);
  if (stats.peakMonthTrackId) ids.add(stats.peakMonthTrackId);
  const tracks: Record<string, Track> = {};
  if (ids.size) {
    try {
      const q = [...ids].map(encodeURIComponent).join(",");
      const res = await api.get<{ tracks: Track[] }>(`/api/library/tracks/by-ids?ids=${q}`);
      for (const t of res.tracks ?? []) tracks[t.id] = t;
    } catch {
      /* no audio is fine */
    }
  }
  return { stats, tracks };
}

// One gate check per year per page session, shared by every entry point.
const gateCache = new Map<number, Promise<boolean>>();

/** Mirrors RewindGate: whether `year` actually has listening data. Failures
 *  count as "no" (and aren't cached, so a later mount can retry). */
export function rewindHasData(year: number): Promise<boolean> {
  let p = gateCache.get(year);
  if (!p) {
    p = fetchRewindStats(year)
      .then((s) => s.hasData === true)
      .catch(() => {
        gateCache.delete(year);
        return false;
      });
    gateCache.set(year, p);
  }
  return p;
}

/** React hook form of the gate. Pass null to skip (returns false). */
export function useRewindGate(year: number | null): boolean {
  const [state, setState] = useState<{ year: number | null; has: boolean }>({ year: null, has: false });
  useEffect(() => {
    if (year == null) return;
    let alive = true;
    rewindHasData(year).then((has) => {
      if (alive) setState({ year, has });
    });
    return () => {
      alive = false;
    };
  }, [year]);
  return year != null && state.year === year && state.has;
}
