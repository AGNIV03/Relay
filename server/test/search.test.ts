import "./helpers/env.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fieldScore, trackScore, rankTracks, rankByName } from "../src/lib/search.js";

describe("fieldScore", () => {
  it("tiers: exact < prefix < word-start < substring < none", () => {
    assert.equal(fieldScore("Playlist", "playlist"), 0);
    assert.equal(fieldScore("Playlist Two", "pla"), 1);
    assert.equal(fieldScore("My Playlist", "pla"), 2);
    assert.equal(fieldScore("Re-Play", "play"), 2); // hyphen is a word boundary
    assert.equal(fieldScore("(Play) it", "play"), 2);
    assert.equal(fieldScore("Cosplay", "pla"), 3);
    assert.equal(fieldScore("Nothing", "pla"), 99);
    assert.equal(fieldScore(null, "pla"), 99);
    assert.equal(fieldScore(undefined, "pla"), 99);
  });

  it("treats regex metacharacters in the query literally", () => {
    assert.equal(fieldScore("AC (DC) live", "(dc"), 2);
    assert.equal(fieldScore("C++ Anthem", "c++"), 1);
    assert.equal(fieldScore("a.b", "."), 3);
    assert.equal(fieldScore("abc", "a.c"), 99);
    assert.equal(fieldScore("x [y", "[y"), 2);
  });

  it("word boundaries are Unicode-aware (letters with accents are not boundaries)", () => {
    assert.equal(fieldScore("Café Olé", "olé"), 2);
    assert.equal(fieldScore("éclair", "clair"), 3);
  });
});

describe("trackScore / rankTracks", () => {
  const t = (title: string, artist?: string, album?: string) => ({
    title,
    artist: artist ? { name: artist } : null,
    album: album ? { title: album } : null,
  });

  it("any title match beats any artist match, which beats any album match", () => {
    assert.ok(trackScore(t("Cosplay"), "pla") < trackScore(t("x", "Pla"), "pla"));
    assert.ok(trackScore(t("x", "Cosplay"), "pla") < trackScore(t("x", "y", "Pla"), "pla"));
    assert.equal(trackScore(t("x", "y", "z"), "pla"), 99);
  });

  it("orders by relevance, then title, stably", () => {
    const tracks = [
      t("Someplace"),
      t("Zed", "Plastic Band"),
      t("My Playlist"),
      t("Playground"),
      t("Pla"),
      t("Alpha", null as unknown as string, "Pla Album"),
      t("Bplaz"),
    ];
    const ranked = rankTracks(tracks, "PLA").map((x) => x.title);
    assert.deepEqual(ranked, ["Pla", "Playground", "My Playlist", "Bplaz", "Someplace", "Zed", "Alpha"]);
  });

  it("keeps input order for exact ties", () => {
    const a = { ...t("Same"), id: 1 };
    const b = { ...t("Same"), id: 2 };
    assert.deepEqual(rankTracks([a, b], "same").map((x) => x.id), [1, 2]);
    assert.deepEqual(rankTracks([b, a], "same").map((x) => x.id), [2, 1]);
  });

  it("does not mutate its input", () => {
    const input = [t("b pla"), t("pla")];
    rankTracks(input, "pla");
    assert.equal(input[0].title, "b pla");
  });
});

describe("rankByName", () => {
  it("ranks albums by title and artists by name", () => {
    assert.deepEqual(
      rankByName([{ title: "Displaced" }, { title: "Place" }, { title: "The Place" }], "place").map((r) => r.title),
      ["Place", "The Place", "Displaced"],
    );
    assert.deepEqual(
      rankByName([{ name: "Coldplay" }, { name: "Play Dead" }], "play").map((r) => r.name),
      ["Play Dead", "Coldplay"],
    );
  });
});
