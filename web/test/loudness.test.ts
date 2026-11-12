// Loudness normalization factor. The same table is asserted in the Flutter app
// (app/test/loudness_test.dart) so every client attenuates identically.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normFactor } from "../src/lib/loudness";

describe("normFactor", () => {
  const table: Array<[number, number]> = [
    // LUFS -> gain
    [-14, 1], //       at target
    [-20, 1], //       quieter than target: never boosted
    [-70, 1], //       silence
    [-8, 0.501187], // 6 LU too loud: -6 dB
    [-11, 0.707946], // -3 dB
    [-2, 0.251189], // -12 dB, just above the floor
    [0, 0.25], //      clamped to the floor (-12 dB max attenuation)
    [10, 0.25],
  ];
  for (const [lufs, gain] of table) {
    it(`${lufs} LUFS → ${gain}`, () => {
      assert.ok(Math.abs(normFactor({ loudnessLufs: lufs }, true) - gain) < 1e-6);
    });
  }

  it("is 1 when off, unmeasured, non-finite or there's no track", () => {
    assert.equal(normFactor({ loudnessLufs: -2 }, false), 1);
    assert.equal(normFactor({ loudnessLufs: null }, true), 1);
    assert.equal(normFactor({}, true), 1);
    assert.equal(normFactor({ loudnessLufs: Number.NaN }, true), 1);
    assert.equal(normFactor(null, true), 1);
  });
});
