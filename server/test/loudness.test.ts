import "./helpers/env.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseIntegrated } from "../src/services/loudness.js";

// Tail of a real `ffmpeg -af ebur128=framelog=quiet -f null -` run.
const summary = (i: string) => `
[Parsed_ebur128_0 @ 0000020c1f3a8e40] Summary:

  Integrated loudness:
    I:         ${i} LUFS
    Threshold: -24.5 LUFS

  Loudness range:
    LRA:         6.3 LU
    Threshold: -34.6 LUFS
    LRA low:   -19.4 LUFS
    LRA high:  -13.1 LUFS
[out#0/null @ 0000020c1f3b1c80] video:0KiB audio:41344KiB subtitle:0KiB other streams:0KiB global headers:0KiB muxing overhead: unknown
size=N/A time=00:03:40.48 bitrate=N/A speed= 412x
`;

describe("parseIntegrated (ebur128 summary)", () => {
  it("reads the integrated loudness from the summary block (not the thresholds)", () => {
    assert.equal(parseIntegrated(summary("-14.2")), -14.2);
    assert.equal(parseIntegrated(summary("-8.0")), -8);
  });

  it("rounds to 0.1 LU", () => {
    assert.equal(parseIntegrated(summary("-9.96")), -10);
    assert.equal(parseIntegrated(summary("-23.04")), -23);
  });

  it("maps -inf (digital silence) to the -70 LUFS absolute gate", () => {
    assert.equal(parseIntegrated(summary("-inf")), -70);
    assert.equal(parseIntegrated(summary("-90.0")), -70);
  });

  it("clamps absurdly loud values to +10", () => {
    assert.equal(parseIntegrated(summary("12.5")), 10);
  });

  it("falls back to the last per-frame 'I: x LUFS' when there is no summary header", () => {
    const frames =
      "t: 0.4  TARGET:-23 LUFS    M: -20.1 S:-120.7     I: -20.1 LUFS       LRA:   0.0 LU\n" +
      "t: 0.8  TARGET:-23 LUFS    M: -18.0 S:-120.7     I: -19.0 LUFS       LRA:   0.0 LU\n";
    assert.equal(parseIntegrated(frames), -19);
  });

  it("returns null when there's nothing to parse", () => {
    assert.equal(parseIntegrated(""), null);
    assert.equal(parseIntegrated("Error opening input file"), null);
    assert.equal(parseIntegrated(summary("nan")), null);
  });
});
