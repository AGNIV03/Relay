// Relevance ranking for text search. The DB filter (`contains`) decides *whether*
// a row matches; this decides the ORDER, so that typing "pla" surfaces titles
// where a word *starts* with the query ("Playlist", "My Playlist") above titles
// that merely contain those letters mid-word ("someplace", "cosplay").

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Score a single field against the (already lower-cased) query.
 * Lower is better; 99 means "no match in this field".
 *   0  exact match
 *   1  field starts with the query
 *   2  a word in the field starts with the query (word-boundary prefix)
 *   3  the query appears somewhere in the field (mid-word substring)
 */
export function fieldScore(text: string | null | undefined, qLower: string): number {
  if (!text) return 99;
  const t = text.toLowerCase();
  if (t === qLower) return 0;
  if (t.startsWith(qLower)) return 1;
  // Word-boundary prefix: query preceded by start-of-string or a non-alphanumeric
  // char (space, hyphen, "(", etc.). Unicode-aware so accented titles still work.
  const wordStart = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(qLower)}`, "u");
  if (wordStart.test(t)) return 2;
  if (t.includes(qLower)) return 3;
  return 99;
}

/**
 * Combined relevance score for a track across its title/artist/album, with a
 * field priority of title > artist > album: any title match beats any artist
 * match, which beats any album match, and within a field the tier (exact >
 * prefix > word-start > substring) breaks the tie. Lower is better.
 */
export function trackScore(
  track: { title: string; artist?: { name: string } | null; album?: { title: string } | null },
  qLower: string,
): number {
  return Math.min(
    fieldScore(track.title, qLower), //        title:  0..3
    4 + fieldScore(track.artist?.name, qLower), // artist: 4..7
    8 + fieldScore(track.album?.title, qLower), // album:  8..11
  );
}

/** Stable sort a matched set by relevance, then alphabetically by title. */
export function rankTracks<
  T extends { title: string; artist?: { name: string } | null; album?: { title: string } | null },
>(tracks: T[], q: string): T[] {
  const qLower = q.toLowerCase();
  return tracks
    .map((t, i) => ({ t, i, s: trackScore(t, qLower) }))
    .sort((a, b) => a.s - b.s || a.t.title.localeCompare(b.t.title) || a.i - b.i)
    .map((x) => x.t);
}

/** Rank a set of {title}-bearing rows (albums/artists) by a single name field. */
export function rankByName<T extends { title?: string; name?: string }>(rows: T[], q: string): T[] {
  const qLower = q.toLowerCase();
  return rows
    .map((r, i) => ({ r, i, s: fieldScore(r.title ?? r.name, qLower) }))
    .sort((a, b) => a.s - b.s || (a.r.title ?? a.r.name ?? "").localeCompare(b.r.title ?? b.r.name ?? "") || a.i - b.i)
    .map((x) => x.r);
}
