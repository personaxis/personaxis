/**
 * E129: a persona made with `personaxis init` is born alive, and `locked` stays what it is, the kill-switch.
 *
 * Until 2026-09-24 every scaffold wrote `mode: locked` inline AND in its sibling policy.yaml, and the runtime
 * takes the stricter of the two, so every persona `init` made never evolved: its state did not move on
 * anything it lived through. The spec required a sign-off (`approved_by`, `last_approval_at`) for any other
 * mode, so the only way to make one alive was to invent who approved it. The sign-off now belongs to
 * `autonomous` only, where a persona may apply edits to its own spec. These tests read
 * what the RUNTIME resolves from the files `init` writes, not what the files say about themselves.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { load as loadYaml } from "js-yaml";

import { readMode } from "@personaxis/core";
import {
  buildCustomAgentTemplate,
  buildMarketingGuru,
  buildPolicyYaml,
  buildProjectBaseline,
  buildUserPersonaTemplate,
} from "../src/commands/init.js";
import { validatePolicy } from "../src/policy.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The persona and its policy.yaml side by side, as `init` leaves them, and the mode the runtime reads. */
function modeOnDisk(doc: string, policy: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pxs-e129-"));
  dirs.push(dir);
  const personaPath = join(dir, "personaxis.md");
  writeFileSync(personaPath, doc);
  writeFileSync(join(dir, "policy.yaml"), policy);
  return readMode(matter(doc).data as Record<string, unknown>, personaPath);
}

const SCAFFOLDS: Array<[string, string, string]> = [
  ["marketing-guru", buildMarketingGuru("Marketing Guru", "marketing-guru"), buildPolicyYaml("marketing-guru")],
  [
    "custom-agent",
    buildCustomAgentTemplate("Helper", "helper", "software engineer", "ship features", "Direct", "make the team faster"),
    buildPolicyYaml("helper"),
  ],
  ["user-persona", buildUserPersonaTemplate("Dana", "dana"), buildPolicyYaml("dana", false)],
  ["project-baseline", buildProjectBaseline("My Project", "my-project"), buildPolicyYaml("my-project")],
];

const policyWith = (improvement_policy: Record<string, unknown>) => ({
  spec_version: "1.1.0",
  applies_to: { persona_name: "w" },
  improvement_policy,
});

describe("a persona made with init is born alive (E129)", () => {
  for (const [name, doc, policy] of SCAFFOLDS) {
    it(`${name}: the runtime reads suggesting from what init writes`, () => {
      expect(modeOnDisk(doc, policy)).toBe("suggesting");
    });
  }

  it("the policy.yaml init writes validates with no invented sign-off", () => {
    const data = loadYaml(buildPolicyYaml("my-project"));
    const result = validatePolicy(data, "my-project");
    expect(result.errors).toEqual([]);
    expect((data as { improvement_policy: Record<string, unknown> }).improvement_policy).toEqual({ mode: "suggesting" });
  });
});

describe("who must sign off, by mode (E129)", () => {
  it("suggesting needs no approved_by: no spec edit applies without a person", () => {
    expect(validatePolicy(policyWith({ mode: "suggesting" })).errors).toEqual([]);
  });

  it("locked needs none either", () => {
    expect(validatePolicy(policyWith({ mode: "locked" })).errors).toEqual([]);
  });

  it("autonomous still needs who allowed it and when", () => {
    const fields = validatePolicy(policyWith({ mode: "autonomous", autonomous_scope_allowlist: ["persona.voice.*"] })).errors.map((e) => e.message).join(" ");
    expect(fields).toContain("approved_by");
    expect(fields).toContain("last_approval_at");
  });

  it("a locked policy.yaml still stops a living persona: the stricter of the two wins", () => {
    const [, doc] = SCAFFOLDS[0]!;
    expect(modeOnDisk(doc, "spec_version: \"1.1.0\"\napplies_to: { persona_name: marketing-guru }\nimprovement_policy: { mode: locked }\n")).toBe("locked");
  });
});
