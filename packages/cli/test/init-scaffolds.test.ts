/**
 * Every `personaxis init` scaffold must produce a VALID v1.0 document out of
 * the box (Clio rule: never silently pass, or silently ship, an invalid
 * persona). Guards the builders against schema drift: if the spec tightens,
 * this fails before an adopter ever scaffolds a broken persona.
 */
import { describe, it, expect } from "vitest";
import matter from "gray-matter";
import {
  buildMarketingGuru,
  buildCustomAgentTemplate,
  buildUserPersonaTemplate,
  buildProjectBaseline,
  buildPolicyYaml,
} from "../src/commands/init.js";
import { validatePersona } from "../src/schema.js";
import { load as loadYaml } from "js-yaml";

const SCAFFOLDS: Array<[string, string]> = [
  ["marketing-guru", buildMarketingGuru("Marketing Guru", "marketing-guru")],
  [
    "custom-agent",
    buildCustomAgentTemplate("Helper", "helper", "software engineer", "ship features", "Direct", "make the team faster"),
  ],
  ["user-persona", buildUserPersonaTemplate("Dana", "dana")],
  ["project-baseline", buildProjectBaseline("My Project", "my-project")],
];

describe("init scaffolds are valid v1.0 documents", () => {
  for (const [name, doc] of SCAFFOLDS) {
    it(`${name} validates PASS/PASS_WITH_WARNINGS as spec 1.0.0`, () => {
      const fm = matter(doc).data as Record<string, unknown>;
      expect(fm.spec_version).toBe("1.0.0");
      expect(fm.apiVersion).toBe("personaxis.com/v1");
      const result = validatePersona(fm);
      expect(
        result.status,
        JSON.stringify(result.errors.slice(0, 5), null, 2),
      ).toMatch(/^PASS/);
    });
  }

  it("policy.yaml scaffold parses and declares spec 1.0.0", () => {
    const y = loadYaml(buildPolicyYaml("my-project-baseline")) as Record<string, unknown>;
    expect(y.spec_version).toBe("1.0.0");
    expect((y.improvement_policy as Record<string, unknown>).mode).toBeDefined();
  });
});
