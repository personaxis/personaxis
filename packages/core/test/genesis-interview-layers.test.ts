import { describe, it, expect } from "vitest";
import { applyAnswers } from "../src/genesis/interview.js";
import { ITEM_BANK } from "../src/genesis/item-bank.js";
import { genesis } from "../src/genesis/index.js";

describe("interview layer coverage (V5.P2.5: metacognition, memory, governance items)", () => {
  it("the bank covers the new layers with named rules", () => {
    const ids = ITEM_BANK.map((i) => i.id);
    expect(ids).toContain("mc-uncertainty");
    expect(ids).toContain("m-memory");
    expect(ids).toContain("g-improve");
  });

  it("maps the three new answers deterministically with evidence", () => {
    const { seed, evidence } = applyAnswers({
      "mc-uncertainty": 0, // cautious
      "m-memory": 2, // minimal
      "g-improve": 1, // suggesting
    });
    expect(seed.uncertainty).toBe("cautious");
    expect(seed.memoryTypes?.semantic).toBe(true);
    expect(seed.memoryTypes?.episodic).toBe(false);
    expect(seed.improvementMode).toBe("suggesting");
    const paths = evidence.flatMap((e) => e.mappedFields.map((m) => m.path));
    expect(paths).toContain("cognition.uncertainty_policy");
    expect(paths).toContain("memory.types");
    expect(paths).toContain("improvement_policy.mode");
  });

  it("the built spec honors the knobs and stays valid-by-construction shaped", () => {
    const { seed } = applyAnswers({
      "id-name": "Layered",
      "id-role": "tester",
      "id-purpose": "cover the layers",
      "mc-uncertainty": 2, // confident
      "g-improve": 2, // autonomous
    });
    const result = genesis([{ label: "test", seed, evidence: [] }]);
    const spec = result.spec as {
      cognition: { uncertainty_policy: { disclose_when_above: number; abstain_when_above: number } };
      improvement_policy: { mode: string };
    };
    expect(spec.cognition.uncertainty_policy.disclose_when_above).toBe(0.45);
    expect(spec.cognition.uncertainty_policy.abstain_when_above).toBe(0.85);
    // Universal #12 always holds.
    expect(spec.cognition.uncertainty_policy.abstain_when_above).toBeGreaterThan(spec.cognition.uncertainty_policy.disclose_when_above);
    expect(spec.improvement_policy.mode).toBe("autonomous");
  });
});
