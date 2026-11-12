import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fmtTime, fmtBytes, fmtDurationLong, fmtDateAdded } from "../src/lib/format";

describe("format helpers", () => {
  it("fmtTime", () => {
    assert.equal(fmtTime(0), "0:00");
    assert.equal(fmtTime(5.9), "0:05");
    assert.equal(fmtTime(65), "1:05");
    assert.equal(fmtTime(3600), "60:00");
    assert.equal(fmtTime(-1), "0:00");
    assert.equal(fmtTime(Number.NaN), "0:00");
    assert.equal(fmtTime(Number.POSITIVE_INFINITY), "0:00");
  });

  it("fmtBytes", () => {
    assert.equal(fmtBytes(0), "0 B");
    assert.equal(fmtBytes(512), "512.0 B");
    assert.equal(fmtBytes(1536), "1.5 KB");
    assert.equal(fmtBytes(5 * 1024 ** 3), "5.0 GB");
  });

  it("fmtDurationLong", () => {
    assert.equal(fmtDurationLong(59), "0m");
    assert.equal(fmtDurationLong(125 * 60), "2h 5m");
    assert.equal(fmtDurationLong(45 * 60), "45m");
  });

  it("fmtDateAdded relative buckets", () => {
    const ago = (days: number) => new Date(Date.now() - days * 86_400_000 - 1000).toISOString();
    assert.equal(fmtDateAdded(undefined), "");
    assert.equal(fmtDateAdded("garbage"), "");
    assert.equal(fmtDateAdded(new Date().toISOString()), "Today");
    assert.equal(fmtDateAdded(ago(1)), "Yesterday");
    assert.equal(fmtDateAdded(ago(3)), "3 days ago");
    assert.equal(fmtDateAdded(ago(8)), "1 week ago");
    assert.equal(fmtDateAdded(ago(21)), "3 weeks ago");
    assert.match(fmtDateAdded(ago(400)), /\d{4}/); // absolute date with a year
  });
});
