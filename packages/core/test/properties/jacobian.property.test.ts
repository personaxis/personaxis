/**
 * PB-J — J_compile is exact and honest (MATH_CORE.md Def. 10).
 *
 *  - the normalized line distance is a metric-like divergence: 0 ⟺ equal docs,
 *    symmetric, bounded by 1;
 *  - a coordinate with per-band expression variants that differ has σ > 0, and
 *    the compile stage changes ONLY at band boundaries (step function);
 *  - staticallyDecorative ⟹ σ = 0 through the real assembler (the lint's cheap
 *    check never contradicts the measured Jacobian).
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  jacobianCompile,
  normalizedLineDistance,
  staticallyDecorative,
  assemblePersonaDoc,
  extractEnvelopes,
  type PersonaFrontmatter,
} from "../../src/index.js";
import { NUM_RUNS } from "./arbitraries.js";

const textArb = fc.string({ minLength: 0, maxLength: 200 });

describe("PB-J normalized line distance", () => {
  it("0 ⟺ equal; symmetric; bounded by 1", () => {
    fc.assert(
      fc.property(textArb, textArb, (a, b) => {
        const d = normalizedLineDistance(a, b);
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThanOrEqual(1);
        expect(normalizedLineDistance(b, a)).toBeCloseTo(d, 12);
        expect(normalizedLineDistance(a, a)).toBe(0);
        if (a === b) expect(d).toBe(0);
        else if (d === 0) expect(a).toBe(b);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

/** A persona whose warmth trait has (possibly identical) per-band expression. */
function personaWith(low: string, moderate: string, high: string): PersonaFrontmatter {
  return {
    spec_version: "1.1.0",
    identity: { display_name: "JacobianTester" },
    personality: {
      traits: {
        warmth: {
          mean: 0.5,
          range: [0, 1],
          expression: { low, moderate, high },
        },
        silent: { mean: 0.5, range: [0, 1] }, // no expression: decorative
      },
    },
  } as unknown as PersonaFrontmatter;
}

const compileFor = (fm: PersonaFrontmatter) => (values: Record<string, number>) =>
  assemblePersonaDoc({
    persona: fm as Record<string, unknown>,
    target: { name: "JacobianTester", isSubagent: false, resourceBase: "./" },
    stateValues: values,
  });

describe("PB-J J_compile against the real assembler", () => {
  const proseArb = fc.stringMatching(/^[A-Za-z ,.]{1,60}$/);

  it("distinct band prose ⟹ σ > 0; identical prose ⟹ σ = 0; decorative flagged", () => {
    fc.assert(
      fc.property(proseArb, proseArb, proseArb, (low, moderate, high) => {
        const fm = personaWith(low, moderate, high);
        const env = extractEnvelopes(fm);
        const report = jacobianCompile({
          envelopes: env.envelopes,
          values: {},
          compile: compileFor(fm),
        });
        const warmth = report.coordinates.find((c) => c.field.endsWith("warmth"))!;
        const silent = report.coordinates.find((c) => c.field.endsWith("silent"))!;

        // The no-expression coordinate is decorative — statically AND measured.
        expect(silent.decorative).toBe(true);
        expect(staticallyDecorative(env.envelopes[silent.field])).toBe(true);

        const allSame = low === moderate && moderate === high;
        if (allSame) {
          expect(warmth.sigma).toBe(0);
          expect(staticallyDecorative(env.envelopes[warmth.field])).toBe(true);
        } else {
          // Adjacent-band prose differs somewhere ⇒ some pair distance > 0.
          const anyAdjacentDiff = low !== moderate || moderate !== high;
          expect(warmth.sigma > 0).toBe(anyAdjacentDiff);
        }
        // Static check never contradicts the measurement.
        if (staticallyDecorative(env.envelopes[warmth.field])) expect(warmth.sigma).toBe(0);
      }),
      { numRuns: Math.min(NUM_RUNS, 100) }, // each case does up to 4 real compiles
    );
  });

  it("the compile stage is a step function: within-band moves change nothing", () => {
    const fm = personaWith("terse.", "balanced.", "warm.");
    const env = extractEnvelopes(fm);
    const compile = compileFor(fm);
    const field = Object.keys(env.envelopes).find((k) => k.endsWith("warmth"))!;
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 0.33, noNaN: true }),
        fc.double({ min: 0, max: 0.33, noNaN: true }),
        (x, y) => {
          // Both values in the low band ⇒ byte-identical artifacts.
          expect(compile({ [field]: x })).toBe(compile({ [field]: y }));
        },
      ),
      { numRuns: 40 },
    );
  });
});
