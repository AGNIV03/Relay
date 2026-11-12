import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installBrowserGlobals, track } from "./helpers";
import {
  pickSort,
  sortTracks,
  loadTrackSort,
  saveTrackSort,
  loadShufflePref,
  saveShufflePref,
  seededShuffle,
  shuffled,
  type TrackOrder,
} from "../src/lib/trackSort";

const ids = (ts: { id: string }[]) => ts.map((t) => t.id);

const lib = [
  track("a", { title: "beta", artist: { id: "x", name: "Zed" }, album: { id: "1", title: "Mid" }, duration: 200, createdAt: "2024-03-01T00:00:00Z" }),
  track("b", { title: "Alpha", artist: { id: "y", name: "abba" }, album: { id: "2", title: "zzz" }, duration: 100, createdAt: "2024-01-01T00:00:00Z" }),
  track("c", { title: "alpha", artist: { id: "z", name: "Mu" }, album: null, duration: 300, createdAt: "2024-02-01T00:00:00Z" }),
];

describe("pickSort", () => {
  it("re-picking the active order flips direction; a new order starts ascending", () => {
    assert.deepEqual(pickSort({ order: "title", asc: true }, "title"), { order: "title", asc: false });
    assert.deepEqual(pickSort({ order: "title", asc: false }, "title"), { order: "title", asc: true });
    assert.deepEqual(pickSort({ order: "title", asc: false }, "artist"), { order: "artist", asc: true });
  });
});

describe("sortTracks", () => {
  it("custom keeps (or reverses) the list order, as a copy", () => {
    const out = sortTracks(lib, "custom", true);
    assert.deepEqual(ids(out), ["a", "b", "c"]);
    assert.notEqual(out, lib);
    assert.deepEqual(ids(sortTracks(lib, "custom", false)), ["c", "b", "a"]);
  });

  it("title is case-insensitive and stable for equal keys (both directions)", () => {
    assert.deepEqual(ids(sortTracks(lib, "title", true)), ["b", "c", "a"]);
    assert.deepEqual(ids(sortTracks(lib, "title", false)), ["a", "b", "c"]); // ties keep input order
  });

  it("artist / album (missing album sorts first ascending)", () => {
    assert.deepEqual(ids(sortTracks(lib, "artist", true)), ["b", "c", "a"]);
    assert.deepEqual(ids(sortTracks(lib, "album", true)), ["c", "a", "b"]);
  });

  it("duration numeric", () => {
    assert.deepEqual(ids(sortTracks(lib, "duration", true)), ["b", "a", "c"]);
    assert.deepEqual(ids(sortTracks(lib, "duration", false)), ["c", "a", "b"]);
  });

  it("added prefers the list's addedAt map, falling back to the library date", () => {
    assert.deepEqual(ids(sortTracks(lib, "added", true)), ["b", "c", "a"]);
    const addedAt = new Map<string, string | undefined>([
      ["a", "2020-01-01T00:00:00Z"],
      ["c", undefined],
    ]);
    assert.deepEqual(ids(sortTracks(lib, "added", true, addedAt)), ["a", "b", "c"]);
  });

  it("does not mutate the input", () => {
    const copy = [...lib];
    for (const o of ["title", "artist", "album", "added", "duration", "custom"] as TrackOrder[]) sortTracks(lib, o, false);
    assert.deepEqual(lib, copy);
  });
});

describe("persisted sort + shuffle prefs", () => {
  let storage: ReturnType<typeof installBrowserGlobals>;
  beforeEach(() => {
    storage = installBrowserGlobals();
  });

  it("round-trips sort_<key> = <order>:<asc|desc>", () => {
    saveTrackSort("pl1", { order: "artist", asc: false });
    assert.equal(storage.getItem("sort_pl1"), "artist:desc");
    assert.deepEqual(loadTrackSort("pl1"), { order: "artist", asc: false });
  });

  it("defaults to custom ascending; unknown orders fall back to custom", () => {
    assert.deepEqual(loadTrackSort("none"), { order: "custom", asc: true });
    storage.setItem("sort_bad", "bogus:desc");
    assert.deepEqual(loadTrackSort("bad"), { order: "custom", asc: false });
  });

  it("shuffle preference defaults off and round-trips", () => {
    assert.equal(loadShufflePref("liked"), false);
    saveShufflePref("liked", true);
    assert.equal(storage.getItem("pl_shuffle_liked"), "true");
    assert.equal(loadShufflePref("liked"), true);
  });
});

describe("seededShuffle", () => {
  const xs = Array.from({ length: 20 }, (_, i) => i);

  it("is a deterministic permutation for a seed", () => {
    const a = seededShuffle(xs, 42);
    assert.deepEqual(a, seededShuffle(xs, 42));
    assert.deepEqual([...a].sort((p, q) => p - q), xs);
    assert.notDeepEqual(a, xs);
    assert.notDeepEqual(a, seededShuffle(xs, 43));
  });

  it("doesn't mutate and handles tiny inputs", () => {
    const copy = [...xs];
    seededShuffle(xs, 1);
    shuffled(xs);
    assert.deepEqual(xs, copy);
    assert.deepEqual(seededShuffle([], 1), []);
    assert.deepEqual(seededShuffle(["only"], 1), ["only"]);
  });
});
