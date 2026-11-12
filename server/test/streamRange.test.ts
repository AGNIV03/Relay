import "./helpers/env.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseRange } from "../src/routes/stream.js";

const T = 1000;

describe("parseRange", () => {
  it("serves the whole file without a header", () => {
    assert.equal(parseRange(undefined, T), null);
    assert.equal(parseRange("", T), null);
  });

  it("parses a-b, a- and whitespace", () => {
    assert.deepEqual(parseRange("bytes=0-99", T), { start: 0, end: 99 });
    assert.deepEqual(parseRange("bytes=100-", T), { start: 100, end: 999 });
    assert.deepEqual(parseRange("bytes=0-0", T), { start: 0, end: 0 });
    assert.deepEqual(parseRange(" bytes=999-999 ", T), { start: 999, end: 999 });
  });

  it("supports suffix ranges (last n bytes), clamped to the file", () => {
    assert.deepEqual(parseRange("bytes=-200", T), { start: 800, end: 999 });
    assert.deepEqual(parseRange("bytes=-1", T), { start: 999, end: 999 });
    assert.deepEqual(parseRange("bytes=-5000", T), { start: 0, end: 999 });
  });

  it("clamps an end past EOF to the last byte", () => {
    assert.deepEqual(parseRange("bytes=500-99999", T), { start: 500, end: 999 });
  });

  it("is unsatisfiable (416) for a start at/after EOF, a zero suffix or an empty file", () => {
    assert.equal(parseRange("bytes=1000-", T), "unsatisfiable");
    assert.equal(parseRange("bytes=5000-6000", T), "unsatisfiable");
    assert.equal(parseRange("bytes=-0", T), "unsatisfiable");
    assert.equal(parseRange("bytes=0-", 0), "unsatisfiable");
    assert.equal(parseRange("bytes=-10", 0), "unsatisfiable");
  });

  it("is unsatisfiable for a start beyond Number.MAX_SAFE_INTEGER", () => {
    assert.equal(parseRange("bytes=99999999999999999999-", T), "unsatisfiable");
  });

  it("treats a reversed range (start > end) as unsatisfiable", () => {
    // Note: RFC 9110 calls this syntactically invalid (ignore → 200 full body);
    // the server answers 416, which players handle the same way.
    assert.equal(parseRange("bytes=500-100", T), "unsatisfiable");
  });

  it("ignores forms it doesn't support (multi-range, other units, garbage) → whole file", () => {
    assert.equal(parseRange("bytes=0-1,5-9", T), null);
    assert.equal(parseRange("items=0-5", T), null);
    assert.equal(parseRange("bytes=-", T), null);
    assert.equal(parseRange("bytes=abc", T), null);
    assert.equal(parseRange("bytes=1.5-2", T), null);
  });
});
