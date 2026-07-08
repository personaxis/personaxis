/**
 * PB-T3 + metric axioms — the denotational core (MATH_CORE.md Defs. 4–6, T3).
 *
 *  - u-space: u(mean)=0, u(max)=+1, u(min)=−1; per-side affine, order-preserving;
 *    fromU inverts toU on the box;
 *  - ρ(x,y) = ‖u(x)−u(y)‖_∞ is a metric (identity, symmetry, triangle);
 *  - bands partition the envelope; crossing ⟺ band(from) ≠ band(to);
 *  - T3: `minStepsToCross` is a CERTIFIED lower bound — an adversary pushing the
 *    maximum admitted delta every step, through the REAL mutation primitive,
 *    can never cross a band boundary in fewer audited steps.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  applyMutation,
  toU,
  fromU,
  projectValue,
  rho,
  bandOf,
  bandCrossing,
  bandBoundaries,
  coordinateDrift,
  driftReport,
  type Envelope,
} from "../../src/index.js";
import { NUM_RUNS, envelopeArb, freshState } from "./arbitraries.js";

/** Non-degenerate envelopes (positive half-width on both sides) for u-inversion. */
const solidEnvelopeArb: fc.Arbitrary<Envelope> = envelopeArb.filter(
  (e) => e.mean - e.min > 1e-6 && e.max - e.mean > 1e-6,
);

const inBox = (e: Envelope) =>
  fc.double({ min: 0, max: 1, noNaN: true }).map((t) => e.min + (e.max - e.min) * t);

describe("u-space (Def. 4)", () => {
  it("anchors: u(mean)=0, u(max)=1, u(min)=−1; fromU inverts toU; order-preserving", () => {
    fc.assert(
      fc.property(solidEnvelopeArb, fc.double({ min: -1, max: 1, noNaN: true }), (e, u) => {
        expect(toU(e.mean, e)).toBe(0);
        expect(toU(e.max, e)).toBe(1);
        expect(toU(e.min, e)).toBe(-1);
        // Round-trip within FP tolerance on the affine maps.
        expect(Math.abs(toU(fromU(u, e), e) - u)).toBeLessThanOrEqual(1e-9);
        const x = fromU(u, e);
        expect(x).toBeGreaterThanOrEqual(e.min - 1e-9);
        expect(x).toBeLessThanOrEqual(e.max + 1e-9);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("projectValue is idempotent and lands in the box", () => {
    fc.assert(
      fc.property(envelopeArb, fc.double({ min: -1e12, max: 1e12, noNaN: true }), (e, x) => {
        const p = projectValue(x, e);
        expect(p).toBeGreaterThanOrEqual(e.min);
        expect(p).toBeLessThanOrEqual(e.max);
        expect(projectValue(p, e)).toBe(p);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("ρ is a metric: identity, symmetry, triangle inequality", () => {
    fc.assert(
      fc.property(
        solidEnvelopeArb.chain((e) =>
          fc.record({ e: fc.constant(e), a: inBox(e), b: inBox(e), c: inBox(e) }),
        ),
        ({ e, a, b, c }) => {
          const envs = { f: e };
          const A = { f: a }, B = { f: b }, C = { f: c };
          expect(rho(A, A, envs)).toBe(0);
          expect(rho(A, B, envs)).toBeCloseTo(rho(B, A, envs), 12);
          expect(rho(A, C, envs)).toBeLessThanOrEqual(rho(A, B, envs) + rho(B, C, envs) + 1e-9);
          expect(rho(A, B, envs)).toBeGreaterThanOrEqual(0);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("bands (Def. 6)", () => {
  it("bands partition the envelope; crossing ⟺ band changed", () => {
    fc.assert(
      fc.property(
        solidEnvelopeArb.chain((e) => fc.record({ e: fc.constant(e), x: inBox(e), y: inBox(e) })),
        ({ e, x, y }) => {
          const [b1, b2] = bandBoundaries(e);
          expect(b1).toBeLessThan(b2);
          const band = bandOf(x, e);
          if (x <= b1) expect(band).toBe("low");
          else if (x <= b2) expect(band).toBe("moderate");
          else expect(band).toBe("high");
          expect(bandCrossing(x, y, e)).toBe(bandOf(x, e) !== bandOf(y, e));
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("PB-T3 evidence cost: minStepsToCross is a certified lower bound", () => {
  it("an adversary at max delta through the real engine never crosses in fewer audited steps", () => {
    fc.assert(
      fc.property(
        solidEnvelopeArb.chain((e) =>
          fc.record({
            e: fc.constant(e),
            start: inBox(e),
            deltaMax: fc.double({ min: 1e-3, max: 0.5, noNaN: true }),
            up: fc.boolean(),
          }),
        ),
        ({ e, start, deltaMax, up }) => {
          const field = "personality.traits.x";
          const envs = { [field]: e };
          const state = freshState();
          state.values[field] = start;
          const startBand = bandOf(start, e);
          const bound = coordinateDrift(field, start, e, deltaMax).minStepsToCross;

          // Adversary: pushes the maximum admitted delta every tick, in one direction.
          let steps = 0;
          for (let i = 0; i < 500; i++) {
            const r = applyMutation(state, envs, {
              field,
              delta: up ? deltaMax : -deltaMax,
              reason: "pb-t3 adversary",
            });
            steps++;
            if (bandOf(r.to, e) !== startBand) {
              // Crossed: the audited-entry count must respect the bound.
              expect(steps).toBeGreaterThanOrEqual(bound);
              expect(state.mutation_log.length).toBe(steps); // every step logged
              return;
            }
            if (r.to === r.from) return; // pinned at the wall inside the same band: no crossing ever
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("driftReport: D = max coordinate drift; layer thresholds flag exceedance", () => {
    fc.assert(
      fc.property(
        solidEnvelopeArb.chain((e) => fc.record({ e: fc.constant(e), x: inBox(e) })),
        fc.double({ min: 0, max: 1, noNaN: true }),
        ({ e, x }, threshold) => {
          const envs = { "personality.traits.a": e };
          const report = driftReport({
            values: { "personality.traits.a": x },
            envelopes: envs,
            maxStepDelta: 0.15,
            thresholds: { personality: threshold },
          });
          expect(report.global).toBeCloseTo(Math.abs(toU(x, e)), 12);
          const layer = report.layers.find((l) => l.layer === "personality")!;
          expect(layer.exceeded).toBe(layer.drift > threshold);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
