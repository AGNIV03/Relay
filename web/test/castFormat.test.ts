// Chromecast helpers: which files go to the receiver as-is (range-seekable) vs.
// as a transcode, and the `start=` offset used to seek a transcode. The same
// format table is asserted in app/test/cast_format_test.dart.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { nativeCastType, withStart, startOf } from "../src/lib/cast";

describe("nativeCastType", () => {
  it("passes formats the Default Media Receiver decodes", () => {
    assert.equal(nativeCastType("mp3", 320), "audio/mpeg");
    assert.equal(nativeCastType("MP3", null), "audio/mpeg");
    assert.equal(nativeCastType("aac", 256), "audio/aac");
    assert.equal(nativeCastType("m4a", 256), "audio/mp4");
    assert.equal(nativeCastType("opus", 160), "audio/ogg");
    assert.equal(nativeCastType("flac", 1411), "audio/flac");
    assert.equal(nativeCastType("wav", 1411), "audio/wav");
  });

  it("transcodes what it can't (ALAC, hi-res FLAC, unknown bitrate, other formats)", () => {
    assert.equal(nativeCastType("m4a", 1800), null);
    assert.equal(nativeCastType("flac", 4608), null);
    assert.equal(nativeCastType("flac", null), null);
    assert.equal(nativeCastType("wma", 192), null);
    assert.equal(nativeCastType(null, null), null);
  });
});

describe("transcode start offset", () => {
  const url = "https://x/api/stream/t1?token=a&format=mp3&bitrate=320";
  it("adds, replaces and drops start=", () => {
    const u = withStart(url, 42.5);
    assert.equal(u, `${url}&start=42.500`);
    assert.equal(withStart(u, 10), `${url}&start=10.000`);
    assert.equal(withStart(u, 0), url);
  });
  it("reads the offset back (0 when absent)", () => {
    assert.equal(startOf(withStart(url, 42.5)), 42.5);
    assert.equal(startOf(url), 0);
    assert.equal(startOf(undefined), 0);
  });
});
