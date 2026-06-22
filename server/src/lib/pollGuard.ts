// Caps how many long-poll connections a single user may hold open at once, so a
// client can't open thousands of 25s-held requests and exhaust the server's
// sockets/event loop. When the cap is hit, the route responds immediately instead
// of holding the connection.

const counts = new Map<string, number>();

/** Max simultaneously-held long-polls per user (across all poll endpoints). */
const MAX_PER_USER = 8;

/** Try to reserve a held-poll slot. Returns false if the user is at the cap. */
export function acquirePoll(userId: string): boolean {
  const n = counts.get(userId) ?? 0;
  if (n >= MAX_PER_USER) return false;
  counts.set(userId, n + 1);
  return true;
}

/** Release a previously-acquired slot. */
export function releasePoll(userId: string): void {
  const n = (counts.get(userId) ?? 1) - 1;
  if (n <= 0) counts.delete(userId);
  else counts.set(userId, n);
}
