/**
 * Synthesized band boundaries keep the declared mean in the band its level says.
 *
 * Measured 2026-10-07 rebuilding Clio on command-a-03-2025: a trait declared at 0.9 with the range
 * [0.7, 1] got boundaries at the envelope thirds (0.8 and 0.9), so its own mean fell in "moderate" and
 * the compiled document said "you show honesty in measured doses". Any envelope that the default bands
 * leave inside one band was split the same way, so every strongly declared trait compiled as moderate.
 */
import { describe, it, expect } from "vitest";
import { crossableBands, bandOf, canCross } from "../src/math/bands.js";

function bandAtMean(mean: number, min: number, max: number) {
  const bands = crossableBands({ mean, min, max });
  expect(bands, `no boundaries for ${mean} in [${min}, ${max}]`).toBeDefined();
  return { band: bandOf(mean, { mean, min, max, bands }), bands: bands! };
}

describe("crossableBands", () => {
  it("keeps a high mean in the high band", () => {
    expect(bandAtMean(0.9, 0.7, 1).band).toBe("high");
    expect(bandAtMean(0.8, 0.7, 0.9).band).toBe("high");
  });

  it("keeps a low mean in the low band", () => {
    expect(bandAtMean(0.1, 0, 0.3).band).toBe("low");
    expect(bandAtMean(0.15, 0.05, 0.25).band).toBe("low");
  });

  it("keeps a moderate mean in the moderate band", () => {
    expect(bandAtMean(0.5, 0.4, 0.6).band).toBe("moderate");
  });

  it("keeps a signed mean in its band", () => {
    expect(bandAtMean(0, -0.3, 0.3).band).toBe("moderate");
  });

  it("still leaves another band reachable inside the envelope, so the number moves something", () => {
    for (const [mean, min, max] of [
      [0.9, 0.7, 1],
      [0.1, 0, 0.3],
      [0.5, 0.4, 0.6],
    ] as const) {
      const { bands } = bandAtMean(mean, min, max);
      const reachable = new Set([min, (min + max) / 2, max, bands.low_max, bands.moderate_max].map((v) => bandOf(v, { mean, min, max, bands })));
      expect(reachable.size, `${mean} in [${min}, ${max}]`).toBeGreaterThanOrEqual(2);
      expect(canCross({ mean, min, max, bands })).toBe(true);
    }
  });
});
