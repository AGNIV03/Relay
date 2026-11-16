import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installBrowserGlobals } from "./helpers";
import {
  loadPlaybackSettings,
  savePlaybackSetting,
  loadRecentSearches,
  addRecentSearch,
  removeRecentSearch,
  clearRecentSearches,
  SETTINGS_EVENT,
} from "../src/lib/prefs2";

let storage: ReturnType<typeof installBrowserGlobals>;
beforeEach(() => {
  storage = installBrowserGlobals();
});

describe("playback settings", () => {
  it("default to autoplay on, normalize on, no fade", () => {
    assert.deepEqual(loadPlaybackSettings(), { autoplay: true, normalize: true, fadeSeconds: 0 });
  });

  it("read the shared keys; fade is clamped to 0..12 and rounded", () => {
    storage.setItem("set_autoplay", "false");
    storage.setItem("set_normalize", "true");
    storage.setItem("set_fade_seconds", "20");
    assert.deepEqual(loadPlaybackSettings(), { autoplay: false, normalize: true, fadeSeconds: 12 });
    storage.setItem("set_fade_seconds", "-3");
    assert.equal(loadPlaybackSettings().fadeSeconds, 0);
    storage.setItem("set_fade_seconds", "4.6");
    assert.equal(loadPlaybackSettings().fadeSeconds, 5);
    storage.setItem("set_fade_seconds", "junk");
    assert.equal(loadPlaybackSettings().fadeSeconds, 0);
  });

  it('treat "0" as off like "false" (same rule the player uses)', () => {
    storage.setItem("set_autoplay", "0");
    storage.setItem("set_normalize", "1");
    const s = loadPlaybackSettings();
    assert.equal(s.autoplay, false);
    assert.equal(s.normalize, true);
  });

  it("saving persists and notifies the player in this tab", () => {
    const seen: unknown[] = [];
    const onEvent = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener(SETTINGS_EVENT, onEvent);
    try {
      savePlaybackSetting("normalize", false);
    } finally {
      window.removeEventListener(SETTINGS_EVENT, onEvent);
    }
    assert.equal(storage.getItem("set_normalize"), "false");
    assert.deepEqual(seen, [{ key: "set_normalize", value: "false" }]);
    assert.equal(loadPlaybackSettings().normalize, false);
  });
});

describe("recent searches", () => {
  it("most recent first, trimmed, case-insensitive de-dupe", () => {
    addRecentSearch("Daft Punk");
    addRecentSearch("  radiohead ");
    const list = addRecentSearch("daft punk");
    assert.deepEqual(list, ["daft punk", "radiohead"]);
    assert.deepEqual(loadRecentSearches(), ["daft punk", "radiohead"]);
  });

  it("ignores blank queries", () => {
    addRecentSearch("x");
    assert.deepEqual(addRecentSearch("   "), ["x"]);
  });

  it("keeps at most 12", () => {
    for (let i = 0; i < 20; i++) addRecentSearch(`q${i}`);
    const list = loadRecentSearches();
    assert.equal(list.length, 12);
    assert.equal(list[0], "q19");
    assert.equal(list[11], "q8");
  });

  it("remove (exact match) and clear", () => {
    addRecentSearch("a");
    addRecentSearch("b");
    assert.deepEqual(removeRecentSearch("A"), ["b", "a"], "remove is exact-match");
    assert.deepEqual(removeRecentSearch("a"), ["b"]);
    assert.deepEqual(clearRecentSearches(), []);
    assert.deepEqual(loadRecentSearches(), []);
  });

  it("survives corrupt or foreign storage values", () => {
    storage.setItem("recent_searches", "{not json");
    assert.deepEqual(loadRecentSearches(), []);
    storage.setItem("recent_searches", JSON.stringify({ a: 1 }));
    assert.deepEqual(loadRecentSearches(), []);
    storage.setItem("recent_searches", JSON.stringify(["ok", 3, null, "fine"]));
    assert.deepEqual(loadRecentSearches(), ["ok", "fine"]);
  });
});
