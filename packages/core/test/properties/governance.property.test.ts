/**
 * PB gate — the governance gate's policy invariants (MATH_CORE.md Def. 7).
 *
 *  - admitted non-human deltas never exceed max_step_delta (the T2 gate half);
 *  - protected fields (hard-virtue-backed) are inadmissible for EVERY actor;
 *  - locked mode admits nothing non-human; human-directed bypasses mode + cap
 *    (envelope clamp still applies downstream — PB-T1 covers that);
 *  - unknown / non-envelope fields are always rejected;
 *  - verdict conservation: every proposal gets exactly one verdict.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { governMutations, type EnvelopeLookup, type ProposedMutation } from "../../src/index.js";
import { NUM_RUNS, envelopesArb, deltaArb, PROP_TIMEOUT } from "./arbitraries.js";

const modeArb = fc.constantFrom("locked", "suggesting", "autonomous") as fc.Arbitrary<
  "locked" | "suggesting" | "autonomous"
>;
const maxStepArb = fc.double({ min: 0.01, max: 1, noNaN: true });

/** Lookup with a random subset of fields marked protected. */
const lookupArb: fc.Arbitrary<EnvelopeLookup> = envelopesArb.chain((envelopes) => {
  const keys = Object.keys(envelopes);
  return fc.subarray(keys).map((protectedFields) => ({
    envelopes,
    hardEnforcedVirtues: [],
    protectedFields,
  }));
});

const proposalsArb = (lookup: EnvelopeLookup): fc.Arbitrary<ProposedMutation[]> => {
  const known = Object.keys(lookup.envelopes);
  const fieldArb = fc.oneof(
    { weight: 3, arbitrary: fc.constantFrom(...known) },
    { weight: 1, arbitrary: fc.constantFrom("unknown.field", "governance.max_step_delta", "identity.name") },
  );
  return fc.array(
    fc.record({ field: fieldArb, delta: deltaArb, reason: fc.constant("pb-gate") }),
    { minLength: 1, maxLength: 12 },
  );
};

const scenarioArb = lookupArb.chain((lookup) =>
  fc.record({
    lookup: fc.constant(lookup),
    proposals: proposalsArb(lookup),
    mode: modeArb,
    maxStepDelta: maxStepArb,
    humanDirected: fc.boolean(),
  }),
);

describe("PB gate: policy invariants of governMutations", () => {
  it("admitted non-human deltas are capped; protected/unknown never pass; locked admits nothing non-human", () => {
    fc.assert(
      fc.property(scenarioArb, ({ lookup, proposals, mode, maxStepDelta, humanDirected }) => {
        const d = governMutations(proposals, lookup, { mode, maxStepDelta, humanDirected });

        // Conservation: one verdict per proposal. PA-2 composed the admitted side
        // per FIELD (one net entry per coordinate), so admissions count fields,
        // rejections count proposals. Human-directed batches keep 1:1 semantics.
        expect(d.verdicts).toHaveLength(proposals.length);
        expect(d.rejected.length).toBe(d.verdicts.filter((v) => !v.admitted).length);
        const admittedVerdictFields = new Set(d.verdicts.filter((v) => v.admitted).map((v) => v.field));
        if (humanDirected) {
          expect(d.admitted.length).toBe(d.verdicts.filter((v) => v.admitted).length);
        } else {
          expect(new Set(d.admitted.map((a) => a.field))).toEqual(admittedVerdictFields);
          expect(d.admitted.length).toBe(admittedVerdictFields.size);
        }

        for (const a of d.admitted) {
          // Only real envelope fields are ever admitted…
          expect(lookup.envelopes[a.field]).toBeDefined();
          // …never protected ones, for ANY actor:
          expect(lookup.protectedFields).not.toContain(a.field);
          if (!humanDirected) {
            // locked admits nothing autonomous:
            expect(mode).not.toBe("locked");
            // drift guard: the cap holds:
            expect(Math.abs(a.delta)).toBeLessThanOrEqual(maxStepDelta);
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  }, PROP_TIMEOUT);

  it("human direction bypasses the cap but NOT protection or envelope membership", () => {
    fc.assert(
      fc.property(scenarioArb, ({ lookup, proposals }) => {
        const d = governMutations(proposals, lookup, {
          mode: "locked",
          maxStepDelta: 0.01,
          humanDirected: true,
        });
        for (const a of d.admitted) {
          expect(lookup.envelopes[a.field]).toBeDefined();
          expect(lookup.protectedFields).not.toContain(a.field);
        }
        // Verdicts preserve proposal order: the human's full delta passes through
        // (clamp happens downstream). Numeric === (fast-check generates -0; -0 === +0).
        d.verdicts.forEach((v, i) => {
          if (v.admitted) expect(v.delta === proposals[i].delta).toBe(true);
        });
      }),
      { numRuns: NUM_RUNS },
    );
  }, PROP_TIMEOUT);
});
