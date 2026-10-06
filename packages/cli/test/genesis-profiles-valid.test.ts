/**
 * E128: every starting profile writes a persona that validates against the spec, the same rule every
 * `init` scaffold and every Genesis path already follows (never ship an invalid persona).
 */
import { describe, expect, it } from "vitest";

import { genesis, GENESIS_PROFILES } from "@personaxis/core";
import { validatePersona } from "../src/schema.js";
import { runCreate } from "../src/commands/create.js";

describe("every Genesis profile writes a valid persona (E128)", () => {
  for (const profile of GENESIS_PROFILES) {
    it(`${profile} validates`, () => {
      const { spec } = genesis([{ label: "test", seed: { displayName: "Profiled", purpose: "be checked", profile }, evidence: [] }]);
      const result = validatePersona(spec as Record<string, unknown>);
      expect(result.status, JSON.stringify(result.errors.slice(0, 5), null, 2)).toMatch(/^PASS/);
    });
  }

  it("create refuses an unknown profile before asking or writing anything", async () => {
    await expect(runCreate(undefined, { profile: "strict", fromPrompt: "x", yes: true })).rejects.toThrow(/--profile must be one of regulated, standard, research/);
  });
});
