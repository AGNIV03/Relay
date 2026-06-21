// In-memory "Chorus" sessions: collaborative group listening (like Spotify Jam,
// but not proximity-based — anyone can join from anywhere).
//
// Playback model: the AUDIO ONLY PLAYS ON THE HOST'S DEVICE. Members are remote
// controls — they see what's playing and can change the song / queue / play-pause
// / seek, but their own device stays silent. To keep this race-free, only the host
// writes the authoritative playback state (via updateState); members enqueue
// *commands* (intents) that the host applies and then re-broadcasts. Every change
// bumps `version` and wakes long-poll waiters so clients sync near-instantly.
//
// Ephemeral (cleared on restart), like presence.

export type ChorusMode = "open" | "ask";

/** A partial playback intent: a member command, or a host's authoritative write. */
export interface ChorusPatch {
  queue?: string[];
  index?: number;
  positionMs?: number;
  playing?: boolean;
}

export interface Chorus {
  hostId: string;
  mode: ChorusMode;
  members: Set<string>; // includes the host
  pending: Set<string>; // ask-to-join requests awaiting approval
  seen: Map<string, number>; // userId -> last poll time (for pruning)
  // Shared playback (authoritative; written only by the host)
  queue: string[]; // ordered trackIds
  index: number; // current position in queue
  positionMs: number;
  playing: boolean;
  updatedAt: number; // epoch ms of the last playback-state update
  controllerId: string; // who last *requested* a change (member or host)
  version: number; // bumps on every change — long-poll cursor
  commands: ChorusPatch[]; // member intents awaiting the host
}

const choruses = new Map<string, Chorus>(); // hostId -> chorus
const memberOf = new Map<string, string>(); // userId -> hostId they belong to
const waiters = new Map<string, Set<() => void>>(); // hostId -> long-poll wakeups

/** A member not seen polling within this window is dropped from the chorus. */
const SEEN_WINDOW_MS = 45_000;

function touch(c: Chorus, userId: string) {
  c.seen.set(userId, Date.now());
}

/** Wake everyone long-polling this chorus (they re-hydrate and respond). */
function wake(hostId: string) {
  const set = waiters.get(hostId);
  if (!set) return;
  for (const fn of [...set]) fn(); // each callback removes itself
}

function bump(c: Chorus) {
  c.version++;
  wake(c.hostId);
}

/** Register a long-poll wakeup for a chorus. Returns an unsubscribe fn. */
export function subscribe(hostId: string, cb: () => void): () => void {
  let set = waiters.get(hostId);
  if (!set) {
    set = new Set();
    waiters.set(hostId, set);
  }
  set.add(cb);
  return () => {
    const s = waiters.get(hostId);
    if (s) {
      s.delete(cb);
      if (s.size === 0) waiters.delete(hostId);
    }
  };
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
      bump(c);
    }
  }
  for (const uid of [...c.pending]) {
    if (now - (c.seen.get(uid) ?? now) > SEEN_WINDOW_MS) {
      c.pending.delete(uid);
      bump(c);
    }
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
    version: 1,
    commands: [],
  };
  choruses.set(hostId, c);
  memberOf.set(hostId, hostId);
  wake(hostId); // anyone discovering/joining can re-poll
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
  wake(hostId); // members' long-polls learn the chorus is gone
}

export function setMode(hostId: string, mode: ChorusMode): void {
  const c = choruses.get(hostId);
  if (c) {
    c.mode = mode;
    bump(c);
  }
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
    bump(c);
    return "joined";
  }
  c.pending.add(userId);
  bump(c);
  return "requested";
}

export function approve(hostId: string, userId: string): boolean {
  const c = choruses.get(hostId);
  if (!c || !c.pending.has(userId)) return false;
  c.pending.delete(userId);
  c.members.add(userId);
  c.seen.set(userId, Date.now());
  memberOf.set(userId, hostId);
  bump(c);
  return true;
}

export function deny(hostId: string, userId: string): void {
  const c = choruses.get(hostId);
  if (c && c.pending.delete(userId)) bump(c);
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
  bump(c);
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

/** Host writes the authoritative playback state (its real player). Host only. */
export function updateState(userId: string, patch: Required<ChorusPatch>): boolean {
  const hostId = memberOf.get(userId);
  if (!hostId || hostId !== userId) return false; // only the host owns the truth
  const c = choruses.get(hostId);
  if (!c) return false;
  c.queue = patch.queue;
  c.index = patch.index;
  c.positionMs = patch.positionMs;
  c.playing = patch.playing;
  c.updatedAt = Date.now();
  touch(c, userId);
  bump(c);
  return true;
}

/** A member (or the host) enqueues a playback intent for the host to apply. */
export function addCommand(userId: string, patch: ChorusPatch): boolean {
  const hostId = memberOf.get(userId);
  if (!hostId) return false;
  const c = choruses.get(hostId);
  if (!c || !c.members.has(userId)) return false;
  c.commands.push(patch);
  c.controllerId = userId;
  touch(c, userId);
  bump(c);
  return true;
}

/** Host pulls and clears the queued member commands (called on each host poll). */
export function drainCommands(hostId: string): ChorusPatch[] {
  const c = choruses.get(hostId);
  if (!c || c.commands.length === 0) return [];
  const cmds = c.commands;
  c.commands = [];
  return cmds;
}
