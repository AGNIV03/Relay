// Chorus (lib/chorus.ts) is in-memory, so its invariants are testable directly:
// only the host writes playback state, members only enqueue commands, ask-mode
// approval, leaving/ending, stale-write ordering and pruning.
// Module state is shared across tests, so every test uses fresh user ids.
import { describe, it, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import * as chorus from "../src/lib/chorus.js";
import { acquirePoll, releasePoll } from "../src/lib/pollGuard.js";

let n = 0;
const ids = (...names: string[]) => names.map((x) => `${x}-${++n}`);
const state = (queue: string[] = ["t1", "t2"], index = 0, positionMs = 0, playing = true) => ({
  queue,
  index,
  positionMs,
  playing,
});

afterEach(() => mock.timers.reset());

describe("chorus membership", () => {
  it("open mode: join immediately; the host is a member", () => {
    const [host, m] = ids("host", "m");
    const c = chorus.startChorus(host, "open", ["t1"], 0, 0, true);
    assert.equal(chorus.joinChorus(m, host), "joined");
    assert.deepEqual([...c.members].sort(), [host, m].sort());
    assert.equal(chorus.chorusHostOf(m), host);
    assert.equal(chorus.getChorusForUser(m), c);
    assert.equal(chorus.hostMode(host), "open");
  });

  it("ask mode: request → pending until approved; denied users never join", () => {
    const [host, a, b] = ids("host", "a", "b");
    const c = chorus.startChorus(host, "ask", [], 0, 0, false);
    assert.equal(chorus.joinChorus(a, host), "requested");
    assert.equal(chorus.joinChorus(b, host), "requested");
    assert.ok(c.pending.has(a) && !c.members.has(a));
    assert.equal(chorus.chorusHostOf(a), null, "pending users are not members");
    assert.equal(chorus.addCommand(a, { playing: false }), false, "pending users can't send commands");
    assert.equal(chorus.approve(host, a), true);
    assert.ok(c.members.has(a));
    chorus.deny(host, b);
    assert.ok(!c.pending.has(b) && !c.members.has(b));
    assert.equal(chorus.approve(host, b), false, "can't approve a denied request");
  });

  it("a pending requester can poll their request (and stays pending while polling)", () => {
    const [host, a] = ids("host", "a");
    const c = chorus.startChorus(host, "ask", [], 0, 0, false);
    chorus.joinChorus(a, host);
    assert.equal(chorus.getChorusForUser(a), c, "requesters see the chorus they asked to join");
    assert.equal(chorus.chorusHostOf(a), null, "...but are still not members");
    chorus.approve(host, a);
    assert.equal(chorus.getChorusForUser(a), c);
    assert.equal(chorus.chorusHostOf(a), host);
  });

  it("a user has at most one outstanding request; asking another host withdraws it", () => {
    const [h1, h2, a] = ids("h1", "h2", "a");
    const c1 = chorus.startChorus(h1, "ask", [], 0, 0, false);
    const c2 = chorus.startChorus(h2, "ask", [], 0, 0, false);
    chorus.joinChorus(a, h1);
    chorus.joinChorus(a, h2);
    assert.ok(!c1.pending.has(a), "first request withdrawn");
    assert.ok(c2.pending.has(a));
    assert.equal(chorus.approve(h1, a), false, "a withdrawn request can't be approved");
    assert.equal(chorus.approve(h2, a), true);
    assert.ok(!c1.members.has(a) && c2.members.has(a), "member of exactly one chorus");
  });

  it("joining an open chorus withdraws a pending request elsewhere", () => {
    const [h1, h2, a] = ids("h1", "h2", "a");
    const c1 = chorus.startChorus(h1, "ask", [], 0, 0, false);
    chorus.startChorus(h2, "open", [], 0, 0, false);
    chorus.joinChorus(a, h1);
    assert.equal(chorus.joinChorus(a, h2), "joined");
    assert.ok(!c1.pending.has(a));
    assert.equal(chorus.chorusHostOf(a), h2);
  });

  it("starting your own chorus or leaving cancels a pending request", () => {
    const [h1, a, b] = ids("h1", "a", "b");
    const c1 = chorus.startChorus(h1, "ask", [], 0, 0, false);
    chorus.joinChorus(a, h1);
    chorus.startChorus(a, "open", [], 0, 0, false);
    assert.ok(!c1.pending.has(a));
    assert.equal(chorus.getChorusForUser(a)?.hostId, a);
    chorus.joinChorus(b, h1);
    chorus.leaveChorus(b);
    assert.ok(!c1.pending.has(b));
    assert.equal(chorus.getChorusForUser(b), undefined);
  });

  it("a denied or host-ended request stops resolving for the requester", () => {
    const [h1, a, b] = ids("h1", "a", "b");
    chorus.startChorus(h1, "ask", [], 0, 0, false);
    chorus.joinChorus(a, h1);
    chorus.joinChorus(b, h1);
    chorus.deny(h1, a);
    assert.equal(chorus.getChorusForUser(a), undefined);
    chorus.endChorus(h1);
    assert.equal(chorus.getChorusForUser(b), undefined);
  });

  it("joining a missing chorus reports notfound", () => {
    const [m] = ids("m");
    assert.equal(chorus.joinChorus(m, "nobody-hosting"), "notfound");
  });

  it("joining another chorus leaves the first", () => {
    const [h1, h2, m] = ids("h1", "h2", "m");
    const c1 = chorus.startChorus(h1, "open", [], 0, 0, false);
    chorus.startChorus(h2, "open", [], 0, 0, false);
    chorus.joinChorus(m, h1);
    chorus.joinChorus(m, h2);
    assert.ok(!c1.members.has(m));
    assert.equal(chorus.chorusHostOf(m), h2);
  });

  it("a member leaving keeps the chorus; the host leaving ends it for everyone", () => {
    const [host, a, b] = ids("host", "a", "b");
    chorus.startChorus(host, "open", [], 0, 0, false);
    chorus.joinChorus(a, host);
    chorus.joinChorus(b, host);
    chorus.leaveChorus(a);
    assert.equal(chorus.chorusHostOf(a), null);
    assert.ok(chorus.getChorusByHost(host));
    chorus.leaveChorus(host);
    assert.equal(chorus.getChorusByHost(host), undefined);
    assert.equal(chorus.chorusHostOf(b), null);
    assert.equal(chorus.getChorusForUser(b), undefined);
  });

  it("starting a new chorus as a member leaves the old one", () => {
    const [h1, m] = ids("h1", "m");
    const c1 = chorus.startChorus(h1, "open", [], 0, 0, false);
    chorus.joinChorus(m, h1);
    chorus.startChorus(m, "open", [], 0, 0, false);
    assert.ok(!c1.members.has(m));
    assert.equal(chorus.chorusHostOf(m), m);
  });
});

describe("chorus host-only playback state", () => {
  it("only the host can write the authoritative state", () => {
    const [host, m, outsider] = ids("host", "m", "x");
    const c = chorus.startChorus(host, "open", ["t1"], 0, 0, true);
    chorus.joinChorus(m, host);
    const v = c.version;
    assert.equal(chorus.updateState(m, state(["evil"])), false);
    assert.equal(chorus.updateState(outsider, state(["evil"])), false);
    assert.deepEqual(c.queue, ["t1"]);
    assert.equal(c.version, v, "rejected writes don't bump the version");
    assert.equal(chorus.updateState(host, state(["a", "b"], 1, 5000, false)), true);
    assert.deepEqual([c.queue, c.index, c.positionMs, c.playing], [["a", "b"], 1, 5000, false]);
    assert.ok(c.version > v);
  });

  it("members enqueue commands; the host drains them in order", () => {
    const [host, m] = ids("host", "m");
    const c = chorus.startChorus(host, "open", ["t1"], 0, 0, true);
    chorus.joinChorus(m, host);
    assert.equal(chorus.addCommand(m, { playing: false }), true);
    assert.equal(chorus.addCommand(m, { index: 1 }), true);
    assert.equal(c.controllerId, m);
    assert.deepEqual(c.queue, ["t1"], "commands never touch the state directly");
    assert.deepEqual(chorus.drainCommands(host), [{ playing: false }, { index: 1 }]);
    assert.deepEqual(chorus.drainCommands(host), []);
  });

  it("non-members can't enqueue commands; the pending command list is capped at 50", () => {
    const [host, m, outsider] = ids("host", "m", "x");
    chorus.startChorus(host, "open", [], 0, 0, false);
    chorus.joinChorus(m, host);
    assert.equal(chorus.addCommand(outsider, { playing: true }), false);
    for (let i = 0; i < 60; i++) chorus.addCommand(m, { index: i });
    const cmds = chorus.drainCommands(host);
    assert.equal(cmds.length, 50);
    assert.equal(cmds[0].index, 10, "oldest commands are dropped");
    assert.equal(cmds[49].index, 59);
  });

  it("drops a timed host write that is older than the stored state (reordered delivery)", () => {
    mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const [host] = ids("host");
    const c = chorus.startChorus(host, "open", [], 0, 0, false);
    mock.timers.tick(5_000);
    assert.equal(chorus.updateState(host, state(["new"]), 1_004_000), true);
    assert.equal(c.updatedAt, 1_004_000);
    assert.deepEqual(c.queue, ["new"]);
    assert.equal(chorus.updateState(host, state(["old"]), 1_002_000), true, "accepted but ignored");
    assert.deepEqual(c.queue, ["new"]);
    assert.equal(c.updatedAt, 1_004_000);
  });

  it("ignores out-of-range atServerMs (stamps 'now' instead)", () => {
    mock.timers.enable({ apis: ["Date"], now: 2_000_000 });
    const [host] = ids("host");
    const c = chorus.startChorus(host, "open", [], 0, 0, false);
    chorus.updateState(host, state(["a"]), 2_000_000 + 60_000); // far future
    assert.equal(c.updatedAt, 2_000_000);
    chorus.updateState(host, state(["b"]), 2_000_000 - 60_000); // too far past
    assert.equal(c.updatedAt, 2_000_000);
    assert.deepEqual(c.queue, ["b"]);
    chorus.updateState(host, state(["c"]), Number.NaN);
    assert.deepEqual(c.queue, ["c"]);
  });

  it("every change wakes long-poll subscribers; unsubscribe stops it", () => {
    const [host, m] = ids("host", "m");
    chorus.startChorus(host, "open", [], 0, 0, false);
    let wakes = 0;
    const unsub = chorus.subscribe(host, () => wakes++);
    chorus.joinChorus(m, host);
    chorus.addCommand(m, { playing: true });
    chorus.updateState(host, state());
    assert.equal(wakes, 3);
    unsub();
    chorus.setMode(host, "ask");
    assert.equal(wakes, 3);
  });
});

describe("chorus pruning", () => {
  it("drops members not seen for 45 s and ends a chorus whose host vanished", () => {
    mock.timers.enable({ apis: ["Date"], now: 10_000_000 });
    const [host, quiet, active] = ids("host", "quiet", "active");
    const c = chorus.startChorus(host, "open", [], 0, 0, false);
    chorus.joinChorus(quiet, host);
    chorus.joinChorus(active, host);
    mock.timers.tick(30_000);
    chorus.getChorusForUser(host); // host polls
    chorus.getChorusForUser(active);
    mock.timers.tick(20_000); // quiet: 50 s silent; host/active: 20 s
    assert.equal(chorus.getChorusForUser(active), c);
    assert.ok(!c.members.has(quiet));
    assert.equal(chorus.getChorusForUser(quiet), undefined);
    // Host goes silent; a member's command finds the chorus abandoned.
    mock.timers.tick(10_000);
    chorus.getChorusForUser(active);
    mock.timers.tick(40_000); // host silent 70 s
    assert.equal(chorus.addCommand(active, { playing: true }), false);
    assert.equal(chorus.getChorusByHost(host), undefined);
  });
});

describe("pollGuard", () => {
  it("caps held long-polls at 8 per user and frees slots on release", () => {
    const [u, other] = ids("u", "other");
    for (let i = 0; i < 8; i++) assert.equal(acquirePoll(u), true);
    assert.equal(acquirePoll(u), false);
    assert.equal(acquirePoll(other), true, "per user");
    releasePoll(u);
    assert.equal(acquirePoll(u), true);
    for (let i = 0; i < 9; i++) releasePoll(u);
    releasePoll(u); // extra releases don't go negative
    for (let i = 0; i < 8; i++) assert.equal(acquirePoll(u), true);
    assert.equal(acquirePoll(u), false);
  });
});
