// In-memory "Chorus" sessions: collaborative, synced group listening (like
// Spotify Jam, but not proximity-based — anyone can join from anywhere).
//
// One chorus per host (keyed by hostId). It holds the shared playback (an ordered
// queue of trackIds + current index + position + playing) plus membership. Any
// member can change the song / queue / playback by posting new state; the host's
// client acts as the position "ticker" while content is stable. Ephemeral
// (cleared on restart), like presence.

export type ChorusMode = "open" | "ask";

export interface Chorus {
  hostId: string;
  mode: ChorusMode;
  members: Set<string>; // includes the host
  pending: Set<string>; // ask-to-join requests awaiting approval
  seen: Map<string, number>; // userId -> last poll time (for pruning)
  // Shared playback
  queue: string[]; // ordered trackIds
  index: number; // current position in queue
  positionMs: number;
  playing: boolean;
  updatedAt: number; // epoch ms of the last playback-state update
  controllerId: string; // who last changed the playback
}

const choruses = new Map<string, Chorus>(); // hostId -> chorus
const memberOf = new Map<string, string>(); // userId -> hostId they belong to

/** A member not seen polling within this window is dropped from the chorus. */
const SEEN_WINDOW_MS = 40_000;

function touch(c: Chorus, userId: string) {
  c.seen.set(userId, Date.now());
}

/** Drop stale members; end the chorus if the host went away. Returns true if the
 *  chorus still exists afterward. */
function prune(c: Chorus): boolean {
  const now = Date.now();
  for (const uid of [...c.members]) {
    if (uid === c.hostId) continue;
    if (now - (c.seen.get(uid) ?? now) > SEEN_WINDOW_MS) {
      c.members.delete(uid);
      c.seen.delete(uid);
      if (memberOf.get(uid) === c.hostId) memberOf.delete(uid);
    }
  }
  for (const uid of [...c.pending]) {
    if (now - (c.seen.get(uid) ?? now) > SEEN_WINDOW_MS) c.pending.delete(uid);
  }
  if (now - (c.seen.get(c.hostId) ?? c.updatedAt) > SEEN_WINDOW_MS) {
    endChorus(c.hostId);
    return false;
  }
  return true;
}

export function getChorusForUser(userId: string): Chorus | undefined {
  const hostId = memberOf.get(userId);
  if (!hostId) return undefined;
  const c = choruses.get(hostId);
  if (!c) {
    memberOf.delete(userId);
    return undefined;
  }
  touch(c, userId);
  if (!prune(c)) return undefined;
  // The user may have been pruned/removed while away.
  if (!c.members.has(userId) && !c.pending.has(userId)) {
    if (memberOf.get(userId) === hostId) memberOf.delete(userId);
    return undefined;
  }
  return c;
}

export function getChorusByHost(hostId: string): Chorus | undefined {
  return choruses.get(hostId);
}

/** A host's chorus mode for friend discovery, or null if they aren't hosting. */
export function hostMode(hostId: string): ChorusMode | null {
  const c = choruses.get(hostId);
  return c ? c.mode : null;
}

export function startChorus(
  hostId: string,
  mode: ChorusMode,
  queue: string[],
  index: number,
  positionMs: number,
  playing: boolean,
): Chorus {
  // Leaving any prior membership first.
  leaveChorus(hostId);
  const c: Chorus = {
    hostId,
    mode,
    members: new Set([hostId]),
    pending: new Set(),
    seen: new Map([[hostId, Date.now()]]),
    queue,
    index,
    positionMs,
    playing,
    updatedAt: Date.now(),
    controllerId: hostId,
  };
  choruses.set(hostId, c);
  memberOf.set(hostId, hostId);
  return c;
}

export function endChorus(hostId: string): void {
  const c = choruses.get(hostId);
  if (!c) return;
  for (const uid of c.members) {
    if (memberOf.get(uid) === hostId) memberOf.delete(uid);
  }
  for (const uid of c.pending) {
    if (memberOf.get(uid) === hostId) memberOf.delete(uid);
  }
  choruses.delete(hostId);
}

export function setMode(hostId: string, mode: ChorusMode): void {
  const c = choruses.get(hostId);
  if (c) c.mode = mode;
}

/** Join (open) or request to join (ask). Returns the outcome. */
export function joinChorus(
  userId: string,
  hostId: string,
): "joined" | "requested" | "notfound" | "full" {
  const c = choruses.get(hostId);
  if (!c) return "notfound";
  if (c.members.has(userId)) return "joined";
  // Leave any other chorus first.
  if (memberOf.get(userId) && memberOf.get(userId) !== hostId) leaveChorus(userId);
  touch(c, userId);
  if (c.mode === "open") {
    c.members.add(userId);
    c.pending.delete(userId);
    memberOf.set(userId, hostId);
    return "joined";
  }
  c.pending.add(userId);
  return "requested";
}

export function approve(hostId: string, userId: string): boolean {
  const c = choruses.get(hostId);
  if (!c || !c.pending.has(userId)) return false;
  c.pending.delete(userId);
  c.members.add(userId);
  c.seen.set(userId, Date.now());
  memberOf.set(userId, hostId);
  return true;
}

export function deny(hostId: string, userId: string): void {
  choruses.get(hostId)?.pending.delete(userId);
}

/** Remove a member (host action) or self-leave. Host leaving ends the chorus. */
export function removeMember(hostId: string, userId: string): void {
  const c = choruses.get(hostId);
  if (!c) return;
  if (userId === hostId) {
    endChorus(hostId);
    return;
  }
  c.members.delete(userId);
  c.pending.delete(userId);
  c.seen.delete(userId);
  if (memberOf.get(userId) === hostId) memberOf.delete(userId);
}

/** A user leaves whatever chorus they're in (ends it if they're the host). */
export function leaveChorus(userId: string): void {
  const hostId = memberOf.get(userId);
  if (!hostId) return;
  if (hostId === userId) {
    endChorus(userId);
  } else {
    removeMember(hostId, userId);
  }
}

/** Update the shared playback (any member). Returns true if applied. */
export function updateState(
  userId: string,
  patch: { queue: string[]; index: number; positionMs: number; playing: boolean },
): boolean {
  const hostId = memberOf.get(userId);
  if (!hostId) return false;
  const c = choruses.get(hostId);
  if (!c || !c.members.has(userId)) return false;
  c.queue = patch.queue;
  c.index = patch.index;
  c.positionMs = patch.positionMs;
  c.playing = patch.playing;
  c.updatedAt = Date.now();
  c.controllerId = userId;
  touch(c, userId);
  return true;
}
