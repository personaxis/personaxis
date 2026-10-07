/**
 * What Genesis writes comes from the source, once.
 *
 * Seen on 2026-10-03 when Clio was rebuilt from her project and a brief (E176): the extraction schema had
 * no virtues, so "Always" held only the builder's honesty line; "Never" opened with a default gerund that
 * repeated the honesty virtue; the purpose was printed in the opener and again in "Who you are" (and a
 * third time as the self-concept default); a goal list repeated the purpose; lists from two sources were
 * concatenated with their duplicates; near-identical values from two sources sat side by side unflagged;
 * and the overview read "Clio, The agent...".
 */
import { describe, it, expect } from "vitest";
import {
  SEED_JSON_SCHEMA,
  seedFromExtraction,
  genesis,
  renderCreationReport,
  assemblePersonaDoc,
  type SeedContribution,
} from "../src/index.js";

const PURPOSE = "Review pull requests for correctness before anything else.";

function extraction(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { displayName: "Lens", role: "code reviewer", purpose: PURPOSE, description: "The reviewer that blocks untested merges.", ...extra };
}

function contribution(label: string, raw: Record<string, unknown>): SeedContribution {
  const { seed, evidence } = seedFromExtraction(raw, label);
  return { label, seed, evidence };
}

function build(...raws: Array<Record<string, unknown>>) {
  return genesis(raws.map((r, i) => contribution(`s${i}`, r)));
}

const count = (text: string, needle: string) => text.split(needle).length - 1;

describe("virtues come from the source", () => {
  it("the extraction schema asks for virtues", () => {
    expect((SEED_JSON_SCHEMA.properties as Record<string, unknown>).virtues).toBeDefined();
  });

  it("an extracted virtue reaches the spec with its own words, beside the universal honesty", () => {
    const r = build(
      extraction({
        virtues: [{ name: "Rigor", description: "Checks every claim against the code it cites.", enforcement: "hard", evidence: "never approves on trust" }],
      }),
    );
    const virtues = (r.spec.character as { virtues: Record<string, { description: string; enforcement: string }> }).virtues;
    expect(virtues.rigor?.description).toBe("Checks every claim against the code it cites.");
    expect(virtues.rigor?.enforcement).toBe("hard");
    expect(virtues.honesty?.enforcement).toBe("hard");
  });

  it("a virtue without evidence from the material is dropped, like a trait or a value", () => {
    const r = build(extraction({ virtues: [{ name: "Charm", description: "Is charming.", enforcement: "soft", evidence: "" }] }));
    expect((r.spec.character as { virtues: Record<string, unknown> }).virtues.charm).toBeUndefined();
  });
});

describe("no filler", () => {
  it("prohibited behaviors are what the source said, without a default that repeats the honesty virtue", () => {
    const given = build(extraction({ prohibitedBehaviors: ["Approving code without tests."] }));
    expect((given.spec.character as { prohibited_behaviors: string[] }).prohibited_behaviors).toEqual(["Approving code without tests."]);
    const none = build(extraction());
    expect((none.spec.character as { prohibited_behaviors: string[] }).prohibited_behaviors).toEqual([]);
  });

  it("goals do not repeat the purpose when the source gave goals", () => {
    const r = build(extraction({ goals: ["Every merged change has a test."] }));
    expect((r.spec.values_and_drives as { goals: string[] }).goals).toEqual(["Every merged change has a test."]);
  });

  it("the compiled document states the purpose once", () => {
    const r = build(extraction());
    const doc = assemblePersonaDoc({ persona: r.spec, target: { name: "Lens", isSubagent: false, resourceBase: "./.personaxis/" } });
    expect(count(doc, PURPOSE)).toBe(1);
  });

  it("lists from two sources keep one copy of the same line", () => {
    const r = build(
      extraction({ hardLimits: ["Never merge without a passing build."] }),
      extraction({ hardLimits: ["never merge without a passing build"] }),
    );
    const limits = (r.spec.self_regulation as { hard_limits: string[] }).hard_limits;
    expect(limits.filter((l) => /never merge without a passing build/i.test(l))).toHaveLength(1);
  });

  it("the overview does not glue the name to a capitalized description", () => {
    const r = build(extraction());
    expect(r.document).not.toContain("Lens, The reviewer");
    expect(r.document).toContain("Lens: The reviewer that blocks untested merges.");
  });

  it("the overview does not repeat the name when the description starts with it", () => {
    const r = build(extraction({ description: "Lens reviews pull requests." }));
    expect(r.document).not.toContain("Lens: Lens");
    expect(r.document).toContain("Lens reviews pull requests.");
  });
});

describe("near-identical values from two sources", () => {
  it("are kept as written and flagged for review in the creation report", () => {
    const r = build(
      extraction({ values: [{ name: "verifiability", weight: 0.8, evidence: "cites the line" }] }),
      extraction({ values: [{ name: "verified_claims", weight: 0.7, evidence: "only verified claims" }] }),
    );
    const values = (r.spec.values_and_drives as { values: Record<string, unknown> }).values;
    expect(values.verifiability).toBeDefined();
    expect(values.verified_claims).toBeDefined();
    const report = renderCreationReport(r, []);
    expect(report).toMatch(/verifiability.*verified_claims|verified_claims.*verifiability/);
  });

  it("does not flag values that only share a short word", () => {
    const r = build(extraction({ values: [
      { name: "user_trust", weight: 0.8, evidence: "a" },
      { name: "user_privacy", weight: 0.8, evidence: "b" },
    ] }));
    expect(renderCreationReport(r, [])).not.toMatch(/user_trust.*user_privacy|user_privacy.*user_trust/);
  });
});
