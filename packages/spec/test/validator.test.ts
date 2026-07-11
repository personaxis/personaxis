/**
 * @personaxis/spec, the five-state validator with version dispatch.
 * (The full behavioral coverage lives in the CLI's test suite, which consumes
 * this package through its shim; this proves the package stands alone.)
 */
import { describe, it, expect } from "vitest";
import {
  validatePersona,
  exitCodeFor,
  personaSchema,
  personaSchemaLegacy,
  policySchema,
  stateSchema,
  memorySchema,
} from "../src/index.js";

describe("@personaxis/spec", () => {
  it("exports the five canonical schemas with v1.0 self-identification", () => {
    expect(String(personaSchema.$id)).toContain("/persona/1.0/");
    expect(String(personaSchemaLegacy.$id)).toContain("/persona/0.10/");
    for (const s of [policySchema, stateSchema, memorySchema]) {
      expect(typeof s.$id).toBe("string");
    }
  });

  it("dispatches a 1.x document to the v1 schema (self_regulation required)", () => {
    const r = validatePersona({
      apiVersion: "personaxis.com/v1",
      kind: "AgentPersona",
      spec_version: "1.0.0",
      metadata: { name: "t", version: "1.0.0", description: "d", created: "2026-01-01" },
      identity: { canonical_id: "t", display_name: "T" },
    });
    expect(r.status).toBe("FAIL_SCHEMA");
    expect(r.errors.some((e) => e.message.includes("self_regulation"))).toBe(true);
  });

  it("dispatches a 0.10 document to the frozen legacy schema (reflexive_self_regulation required)", () => {
    const r = validatePersona({
      apiVersion: "persona.dev/v1",
      kind: "AgentPersona",
      spec_version: "0.10.0",
      metadata: { name: "t", version: "1.0.0", display_name: "T", description: "d", created: "2026-01-01" },
      identity: { canonical_id: "t", display_name: "T" },
    });
    expect(r.status).toBe("FAIL_SCHEMA");
    expect(r.errors.some((e) => e.message.includes("reflexive_self_regulation"))).toBe(true);
  });

  it("maps the five statuses to the sanctioned exit codes", () => {
    expect(exitCodeFor("PASS")).toBe(0);
    expect(exitCodeFor("PASS_WITH_WARNINGS")).toBe(0);
    expect(exitCodeFor("FAIL_SCHEMA")).toBe(1);
    expect(exitCodeFor("FAIL_POLICY")).toBe(2);
    expect(exitCodeFor("FAIL_CONCEPTUAL")).toBe(3);
  });
});
