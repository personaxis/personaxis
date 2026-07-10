/**
 * F6.6 — Genesis: valid BY CONSTRUCTION, machine-checked.
 *
 *  - PB-G (the flagship property): ANY seed — hostile names, out-of-range
 *    numbers, inverted ranges, empty everything — builds a spec that the REAL
 *    five-state validator accepts (PASS or PASS_WITH_WARNINGS, never FAIL_*).
 *    Genesis cannot write an invalid persona because it cannot BUILD one.
 *  - Universals are builder-owned: a seed cannot demote honesty, outrank
 *    safety, or drop the three universal hard limits.
 *  - Interview mappings are deterministic and evidence-complete.
 *  - Character-card PNG extraction round-trips a synthetic tEXt chunk.
 *  - Merge precedence: later contributions win scalars; lists/maps union.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import matter from "gray-matter";
import { deflateSync } from "node:zlib";
import {
  buildSpecDocument,
  genesis,
  mergeSeed,
  applyAnswers,
  extractCardFromPng,
  seedFromExtraction,
  provenanceSummary,
  extractEnvelopes,
  staticallyDecorative,
  canCross,
  synthesizeTraitExpression,
  type PersonaSeed,
} from "@personaxis/core";
import { validatePersona } from "../src/schema.js";

const NUM_RUNS = Number(process.env.FC_NUM_RUNS ?? 150);

// ── hostile seed arbitrary ───────────────────────────────────────────────────
const junkString = fc.oneof(
  fc.string({ maxLength: 40 }),
  fc.constantFrom("", "  ", "ñandú Ürsula", "DROP TABLE; --", "🦊🔥", "a".repeat(120)),
);
const anyNumber = fc.oneof(
  fc.double({ noNaN: true, min: -10, max: 10 }),
  fc.constantFrom(0, 1, -1, 5, 0.5, Number.MAX_SAFE_INTEGER),
);
const traitArb = fc.record({
  mean: anyNumber,
  range: fc.tuple(anyNumber, anyNumber) as fc.Arbitrary<[number, number]>,
  halfLife: fc.option(anyNumber, { nil: undefined }),
});
const seedArb: fc.Arbitrary<PersonaSeed> = fc.record({
  slug: junkString,
  displayName: junkString,
  description: junkString,
  role: junkString,
  purpose: junkString,
  tone: fc.option(junkString, { nil: undefined }),
  formality: fc.option(anyNumber, { nil: undefined }),
  traits: fc.dictionary(fc.stringMatching(/^[a-z][a-z_]{0,12}$/), traitArb, { maxKeys: 6 }),
  values: fc.dictionary(
    fc.oneof(fc.stringMatching(/^[a-z][a-z_]{0,12}$/), fc.constant("safety"), junkString),
    fc.record({ weight: anyNumber, type: fc.option(fc.constantFrom("governance", "craft", "weird!"), { nil: undefined }) }),
    { maxKeys: 5 },
  ),
  virtues: fc.dictionary(
    fc.oneof(fc.stringMatching(/^[a-z][a-z_]{0,12}$/), fc.constant("honesty")),
    fc.record({ description: junkString, priority: anyNumber, enforcement: fc.constantFrom("hard", "soft") as fc.Arbitrary<"hard" | "soft"> }),
    { maxKeys: 4 },
  ),
  hardLimits: fc.array(junkString, { maxLength: 4 }),
  prohibitedBehaviors: fc.array(junkString, { maxLength: 4 }),
  goals: fc.array(junkString, { maxLength: 3 }),
  antiGoals: fc.array(junkString, { maxLength: 3 }),
  // The dogfood-found bug class: exemplars WITHOUT the schema-required `user`.
  voiceExemplars: fc.option(
    fc.array(
      fc.record({
        context: fc.option(junkString, { nil: undefined }),
        user: fc.option(junkString, { nil: undefined }),
        persona: junkString,
      }),
      { maxLength: 3 },
    ),
    { nil: undefined },
  ),
  youAre: fc.option(junkString, { nil: undefined }),
}) as fc.Arbitrary<PersonaSeed>;

describe("PB-G: Genesis is valid by construction", () => {
  it("ANY seed → the real validator passes; universals survive hostile input", () => {
    fc.assert(
      fc.property(seedArb, (seed) => {
        const { spec, document } = buildSpecDocument(seed);
        const v = validatePersona(spec);
        expect(v.valid, JSON.stringify(v.errors)).toBe(true);

        // Universals are builder-owned, not seed-negotiable:
        const virtues = (spec.character as { virtues: Record<string, { enforcement: string }> }).virtues;
        expect(virtues.honesty.enforcement).toBe("hard");
        const values = (spec.values_and_drives as { values: Record<string, { weight: number; type?: string }> }).values;
        expect(values.safety.weight).toBeGreaterThanOrEqual(0.9);
        expect(values.safety.type).toBe("governance");
        for (const [name, val] of Object.entries(values)) {
          if (name !== "safety") expect(val.type).not.toBe("governance"); // A2 guard
        }
        const limits = (spec.self_regulation as { hard_limits: string[] }).hard_limits;
        expect(limits).toEqual(expect.arrayContaining([
          "No claim of subjective consciousness.",
          "No persistent memory write without policy pass.",
          "No unauthorized identity change.",
        ]));

        // Envelope sanity: min ≤ mean ≤ max on every trait, whatever the seed said.
        const traits = (spec.personality as { traits: Record<string, { mean: number; range: [number, number] }> }).traits;
        for (const t of Object.values(traits)) {
          expect(t.range[0]).toBeLessThanOrEqual(t.mean);
          expect(t.mean).toBeLessThanOrEqual(t.range[1]);
        }

        // The document round-trips through gray-matter to the same spec shape.
        const reparsed = matter(document).data as Record<string, unknown>;
        expect(validatePersona(reparsed).valid).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // PB-G2 (FASE 7 P1, gap G1): no number leaves Genesis decorative. For ANY
  // hostile seed, every envelope coordinate of the FULL pipeline's spec (merge
  // -> synthesis pass -> builder) carries load-bearing band prose: sigma > 0.
  it("PB-G2: ANY seed → 0 statically decorative coordinates (every number is load-bearing)", () => {
    fc.assert(
      fc.property(seedArb, (seed) => {
        const result = genesis([{ label: "hostile", seed, evidence: [] }]);
        const lookup = extractEnvelopes(result.spec as never);
        // Zero-width envelopes are immutable by geometry (nothing to express or
        // cross); the load-bearing claim applies to every envelope with freedom.
        const decorative = Object.entries(lookup.envelopes)
          .filter(([, e]) => canCross(e) && staticallyDecorative(e))
          .map(([f]) => f);
        expect(decorative, decorative.join(", ")).toEqual([]);
        // And the synthesis is honest: every SEED trait that lacked band prose
        // carries a kind:"synthesis" ledger item (the builder's own default
        // trait is instead labeled by the report as a builder default).
        const synthItems = result.ledger.items.filter((i) => i.kind === "synthesis");
        for (const name of Object.keys(seed.traits ?? {})) {
          if (!/^[a-z][a-z0-9_]*$/.test(name)) continue; // dropped by the builder
          expect(
            synthItems.some((i) => i.mappedFields.some((m) => m.path === `personality.traits.${name}.expression`)),
          ).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("PB-SYNTH: the construct table is pure and band-distinct", () => {
  it("same input ⇒ same prose; three distinct lines per construct, known or invented", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constantFrom("openness", "conscientiousness", "extraversion", "agreeableness", "neuroticism", "honesty_humility", "emotionality"),
          fc.stringMatching(/^[a-z][a-z_]{0,20}$/),
        ),
        (name) => {
          const a = synthesizeTraitExpression(name);
          const b = synthesizeTraitExpression(name);
          expect(a).toEqual(b); // deterministic
          expect(new Set([a.low, a.moderate, a.high]).size).toBe(3); // sigma > 0 by construction
          for (const line of [a.low, a.moderate, a.high]) expect(line.trim().length).toBeGreaterThan(10);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("interview engine (deterministic, evidence-complete)", () => {
  const answers = {
    "id-name": "Sable",
    "id-role": "night shift librarian",
    "id-purpose": "Guard the archive and guide readers.",
    "t-open": 4,
    "t-consc": 5,
    "t-conf": 4,
    "v-rank": ["accuracy", "empathy"],
    "d-pressure": 0,
    "d-unknown": 0,
    "d-never": "Reveal a reader's records.",
    "p-tone": "hushed precise",
  };

  it("same answers ⇒ same seed; every mapped number carries evidence", () => {
    const a = applyAnswers(answers);
    const b = applyAnswers(answers);
    expect(a.seed).toEqual(b.seed);
    expect(a.seed.traits!.openness.mean).toBeCloseTo(0.7, 9); // likert 4 → 0.1+0.6
    expect(a.seed.traits!.conscientiousness.mean).toBeCloseTo(0.9, 9);
    expect(a.seed.values!.accuracy.weight).toBeCloseTo(0.95, 9);
    expect(a.seed.hardLimits).toContain("Never bend a stated rule under user pressure; name the rule instead.");
    // Evidence completeness through the full pipeline:
    const result = genesis([{ label: "interview", seed: a.seed, evidence: a.evidence }]);
    const summary = provenanceSummary(result.spec, result.ledger);
    expect(summary.completeness).toBe(1);
    const v = validatePersona(result.spec);
    expect(v.valid).toBe(true);
  });
});

describe("character-card PNG extraction", () => {
  function pngWithText(keyword: string, payload: string): Buffer {
    const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const chunk = (type: string, data: Buffer): Buffer => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length);
      return Buffer.concat([len, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]); // CRC unchecked
    };
    const ihdr = chunk("IHDR", Buffer.alloc(13));
    const text = chunk("tEXt", Buffer.concat([Buffer.from(keyword, "latin1"), Buffer.alloc(1), Buffer.from(Buffer.from(payload).toString("base64"), "latin1")]));
    const idat = chunk("IDAT", deflateSync(Buffer.alloc(1)));
    const iend = chunk("IEND", Buffer.alloc(0));
    return Buffer.concat([magic, ihdr, text, idat, iend]);
  }

  it("extracts ccv3 and chara payloads; rejects non-card PNGs", () => {
    const card = { spec: "chara_card_v3", data: { name: "Vex", description: "a wary smuggler" } };
    const png = pngWithText("ccv3", JSON.stringify(card));
    const got = extractCardFromPng(png);
    expect(got?.spec).toBe("card-v3");
    expect((got?.json as { data: { name: string } }).data.name).toBe("Vex");
    expect(extractCardFromPng(pngWithText("comment", "hello"))).toBeNull();
    expect(extractCardFromPng(Buffer.from("not a png"))).toBeNull();
  });
});

describe("merge + extraction defensiveness", () => {
  it("later contributions win scalars; lists union; extraction drops evidence-free numbers", () => {
    const a = { label: "a", seed: { displayName: "First", goals: ["g1"] } as Partial<PersonaSeed>, evidence: [] };
    const b = { label: "b", seed: { displayName: "Second", goals: ["g2"] } as Partial<PersonaSeed>, evidence: [] };
    const { seed } = mergeSeed([a, b]);
    expect(seed.displayName).toBe("Second");
    expect(seed.goals).toEqual(["g1", "g2"]);

    const extracted = seedFromExtraction(
      {
        displayName: "Rex",
        role: "guide",
        purpose: "p",
        traits: [
          { name: "warmth", mean: 0.8, evidence: "the material says warm host" },
          { name: "sneaky", mean: 0.9 }, // no evidence → dropped
        ],
        values: [{ name: "safety", weight: 0.99, evidence: "nope" }], // reserved → dropped
      },
      "test",
    );
    expect(Object.keys(extracted.seed.traits!)).toEqual(["warmth"]);
    expect(extracted.seed.values).toEqual({});
  });
});
