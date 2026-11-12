import type { Track } from "./types";

/** Loudness normalization factor (same formula on every client): bring the
 *  track's integrated loudness down toward -14 LUFS, never boosting. */
export function normFactor(t: Pick<Track, "loudnessLufs"> | null, normalize: boolean): number {
  if (!t || !normalize) return 1;
  const l = t.loudnessLufs;
  if (l == null || !Number.isFinite(l)) return 1;
  return Math.min(1, Math.max(0.25, Math.pow(10, (-14 - l) / 20)));
}
