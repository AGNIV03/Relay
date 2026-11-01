// Query-string helpers. Express parses `?q=a&q=b` into an array, so a handler
// that assumes a string would throw; these coerce to a single value instead.

/** First string value of a query param (arrays → first element), else undefined. */
export function queryString(v: unknown): string | undefined {
  if (Array.isArray(v)) v = v[0];
  return typeof v === "string" ? v : undefined;
}

/** Short alias of queryString. */
export const qstr = queryString;

/** Query param as a number (NaN when absent/non-numeric). */
export function qnum(v: unknown): number {
  const s = queryString(v);
  return s === undefined || s.trim() === "" ? NaN : Number(s);
}
