/**
 * The linter must be version-aware, exactly like the validator: a v1.0 persona
 * must NOT be flagged for the legacy apiVersion, an unsupported spec_version, a
 * dropped metadata.display_name, or a "missing" reflexive_self_regulation layer
 * (renamed to self_regulation in v1.0). This guards against the F5 regression
 * where `validate` passed a v1.0 persona but `lint` emitted three false errors.
 */
import { describe, it, expect } from "vitest";
import { runRules } from "../src/linter/rules.js";

const TEN_LAYERS = [
  "identity",
  "character",
  "personality",
  "values_and_drives",
  "affect",
  "cognition",
  "memory",
  "metacognition",
  "persona",
];

function makePersona(opts: { v1: boolean }): Record<string, unknown> {
  const layer9 = opts.v1 ? "self_regulation" : "reflexive_self_regulation";
  const data: Record<string, unknown> = {
    apiVersion: opts.v1 ? "personaxis.com/v1" : "persona.dev/v1",
    kind: "AgentPersona",
    spec_version: opts.v1 ? "1.0.0" : "0.10.0",
    metadata: {
      name: "test-persona",
      version: "1.0.0",
      description: "A fixture persona for linter version tests.",
      created: "2026-07-07",
      ...(opts.v1 ? {} : { display_name: "Test" }),
    },
    character: {
      prohibited_behaviors: ["Never fabricate a citation."],
    },
    [layer9]: {
      hard_limits: [
        "No claim of subjective consciousness.",
        "No persistent memory write without policy pass.",
        "No unauthorized identity change.",
      ],
      ...(opts.v1 ? {} : { principled_refusals: ["Refuse to weaken a safety universal."] }),
    },
  };
  for (const l of TEN_LAYERS) if (!(l in data)) data[l] = {};
  return data;
}

const rulesOf = (findings: { rule: string }[]) => new Set(findings.map((f) => f.rule));

describe("linter version awareness (v1.0 vs legacy)", () => {
  it("does not flag a valid v1.0 persona for version/layer-9/display_name", () => {
    const { findings, missingLayers } = runRules(makePersona({ v1: true }));
    const rules = rulesOf(findings);
    expect(rules.has("api-version")).toBe(false);
    expect(rules.has("spec-version")).toBe(false);
    expect(rules.has("missing-required-layers")).toBe(false);
    expect(rules.has("universal-hard-limit-missing")).toBe(false);
    // metadata.display_name is not required at v1.0
    expect(findings.some((f) => f.path === "metadata.display_name")).toBe(false);
    // self_regulation counts as present; reflexive_self_regulation is not "missing"
    expect(missingLayers).not.toContain("reflexive_self_regulation");
    expect(missingLayers).toHaveLength(0);
  });

  it("still accepts a legacy 0.10 persona at its legacy paths", () => {
    const { findings, missingLayers } = runRules(makePersona({ v1: false }));
    const rules = rulesOf(findings);
    expect(rules.has("api-version")).toBe(false);
    expect(rules.has("spec-version")).toBe(false);
    expect(rules.has("missing-required-layers")).toBe(false);
    expect(missingLayers).toHaveLength(0);
  });

  it("flags a v1.0 persona that mistakenly keeps the legacy layer-9 name", () => {
    const data = makePersona({ v1: true });
    data.reflexive_self_regulation = data.self_regulation;
    delete data.self_regulation;
    const { findings } = runRules(data);
    expect(findings.some((f) => f.rule === "missing-required-layers" && f.path === "self_regulation")).toBe(true);
  });
});
