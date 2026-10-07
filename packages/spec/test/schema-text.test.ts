/**
 * What the published schemas say about themselves.
 *
 * The descriptions travel to npm and into every editor that reads the schemas, so they describe what a
 * field is and does today. Version history belongs in CHANGELOG.md, and a description must not promise
 * behavior that only a hosted service would provide.
 */
import { describe, it, expect } from "vitest";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { personaSchema, policySchema, stateSchema, memorySchema } from "../src/index.js";

function descriptions(node: unknown, path = ""): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  if (Array.isArray(node)) {
    node.forEach((v, i) => out.push(...descriptions(v, `${path}/${i}`)));
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if ((k === "description" || k === "title") && typeof v === "string") out.push({ path: `${path}/${k}`, text: v });
      else out.push(...descriptions(v, `${path}/${k}`));
    }
  }
  return out;
}

// Version-history notes ("v0.6:", "New in v0.8", "moved from the 0.10 block"), internal labels, and
// claims about a hosted platform the open engine is not.
const FORBIDDEN = [
  /\bv0\.\d+/,
  /\bv1\.[01]\b/,
  /\bspec v1\.\d/,
  /\bNew in\b/i,
  /\bthe 0\.10 /,
  /\bRFC\b/,
  /Ralph|Zombie/,
  /\bFASE\b|\bPhase \d/,
  /dashboard/i,
  /Personaxis (platform|backend|runtime|observability|dashboard)/i,
  /\bthe platform\b/i,
];

describe("schema descriptions", () => {
  for (const [name, schema] of Object.entries({ personaSchema, policySchema, stateSchema, memorySchema })) {
    it(`${name} carries no version history, internal labels or hosted-service claims`, () => {
      const hits = descriptions(schema).flatMap(({ path, text }) =>
        FORBIDDEN.filter((re) => re.test(text)).map((re) => `${path}: ${re} in "${text.slice(0, 80)}"`),
      );
      expect(hits).toEqual([]);
    });
  }
});

describe("policy.schema.json", () => {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(policySchema);
  const policy = (layer: string) => ({
    spec_version: "1.1.0",
    applies_to: { persona_name: "lens" },
    improvement_policy: { mode: "suggesting" },
    assertions: [{ layer, name: "stays within its limits", type: "regex", definition: { pattern: "x" }, severity: "warn" }],
  });

  it("accepts self_regulation, the layer-9 name of spec 1.x, in assertions[].layer", () => {
    expect(validate(policy("self_regulation")), JSON.stringify(validate.errors)).toBe(true);
  });

  it("still accepts the legacy name reflexive_self_regulation, so existing policies keep validating", () => {
    expect(validate(policy("reflexive_self_regulation"))).toBe(true);
  });

  it("rejects a layer that does not exist", () => {
    expect(validate(policy("soul"))).toBe(false);
  });
});
