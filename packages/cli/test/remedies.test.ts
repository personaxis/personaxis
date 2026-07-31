/**
 * V7.B4: no finding without a remedy.
 *
 * The type system already forces `fix` to exist on every Finding and every
 * ValidationIssue, so this suite guards what a type cannot: that the remedy is
 * ACTIONABLE. An empty string, a restatement of the message, or "invalid value"
 * all typecheck and all leave the reader exactly where they started.
 *
 * The generator drives a deliberately broken persona through both engines and
 * asserts the shape of every remedy that comes back, so a rule added later is
 * covered without touching this file.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
import matter from "gray-matter";
import { validatePersona } from "@personaxis/spec";
import { runRules } from "../src/linter/rules.js";
import { lint } from "../src/linter/index.js";
import { validatePolicy } from "../src/policy.js";
import { writeStarterPersona } from "../src/starter.js";
import { doctorChecksOffline } from "../src/repl/doctor-checks.js";

/**
 * A structurally VALID persona (the starter, which passes validate out of the
 * box) with the universals knocked out one by one. Structural validity matters:
 * the validator short-circuits on FAIL_SCHEMA, so a document that fails Ajv
 * never reaches the conceptual and policy checks this suite is about.
 */
function validThenBroken(): Record<string, unknown> {
  const dir = mkdtempSync(join(tmpdir(), "pxs-remedy-"));
  try {
    // structuredClone is load-bearing: gray-matter caches parse results by input
    // string, so two reads of identical content share ONE data object and the
    // mutations below would leak into the next call.
    const data = structuredClone(
      matter(readFileSync(writeStarterPersona(dir, "Vega"), "utf-8")).data,
    ) as Record<string, unknown>;
    // Sanity: the starting point must really be valid, otherwise this suite
    // silently degrades into "schema errors have remedies" and stops covering
    // the universals.
    expect(validatePersona(data).valid, "the starter persona must validate").toBe(true);
    // Break U12, the ordering constraint between the two uncertainty
    // thresholds. Most universals are ALSO pinned in the JSON Schema, so
    // breaking those trips Ajv first and the semantic layer never runs; U12 is
    // a relation between two legal values, which only the semantic pass can
    // catch. That makes it the honest way to exercise FAIL_POLICY remedies.
    (data.cognition as Record<string, unknown>).uncertainty_policy = {
      disclose_when_above: 0.9,
      abstain_when_above: 0.2,
    };
    return data;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A persona that trips as many distinct SCHEMA and lint checks as one document can. */
function brokenPersona(): Record<string, unknown> {
  return {
    apiVersion: "persona.dev/v1", // wrong for a 1.x document
    kind: "AgentPersona",
    spec_version: "1.1.0",
    metadata: { name: "broken" }, // missing version/description/created
    identity: {}, // missing canonical_id, purpose, primary_role
    character: { virtues: { honesty: { enforcement: "soft" } } }, // must be hard
    personality: { traits: {} },
    values_and_drives: { values: { safety: { weight: 0.2, type: "instrumental" } } },
    affect: { representation: "wrong", regulation_policy: {} },
    cognition: { uncertainty_policy: { disclose_when_above: 0.9, abstain_when_above: 0.2 } },
    memory: { deletion_policy: { user_request_supported: false }, retrieval_policy: {} },
    metacognition: {},
    self_regulation: { hard_limits: [] },
    persona: { constraints: {} },
    runtime: { min_consistency: 4, allowed_consumers: ["banana"] },
    assertions: [{ layer: "nope", type: "nope", severity: "nope" }],
  };
}

/**
 * A remedy has to tell the reader what to CHANGE. These are the ways a string
 * can satisfy the type and still be worthless.
 */
function assertActionable(fix: string, label: string): void {
  expect(fix, `${label}: remedy is empty`).toBeTruthy();
  expect(fix.length, `${label}: remedy too short to say anything`).toBeGreaterThan(24);
  // An imperative verb, or an explicit statement that no edit is needed.
  expect(
    /\b(add|set|remove|delete|replace|raise|lower|rename|run|change|correct|fix|make|give|merge|check|open|reformat|adjust|prefix|fill|inspect|use|pick|either|bring|nothing to (do|change)|optional)\b/i.test(fix),
    `${label}: remedy does not open with an action ("${fix.slice(0, 60)}...")`,
  ).toBe(true);
}

describe("every validator issue carries an actionable remedy (V7.B4)", () => {
  it("covers conceptual and policy failures, category by category", () => {
    const seen = new Set<string>();
    const categories = new Set<string>();
    // validatePersona short-circuits by category, so each pass repairs what it
    // reported and the next pass reaches the next class of failure.
    let data = validThenBroken();
    for (let pass = 0; pass < 8; pass++) {
      const result = validatePersona(data);
      for (const issue of [...result.errors, ...result.warnings]) {
        seen.add(issue.field);
        categories.add(issue.category);
        assertActionable(issue.fix, `${issue.category} ${issue.field}`);
      }
      if (result.valid && result.warnings.length === 0) break;
      const before = JSON.stringify(data);
      data = repairOnce(data, result.errors.map((e) => e.field));
      if (JSON.stringify(data) === before) break; // nothing left this pass can repair
    }
    expect(seen.size, "the broken persona should trip at least one field").toBeGreaterThan(0);
    expect(categories.has("FAIL_POLICY"), "the semantic policy layer must be reached").toBe(true);
  });

  it("names the actual expected value, not just the rule id", () => {
    // Ajv renders a `const` violation as "must be equal to constant" without
    // saying which constant. The remedy has to.
    const broken = structuredClone(validThenBroken());
    broken.apiVersion = "persona.dev/v1";
    const api = validatePersona(broken).errors.find((e) => e.field.includes("apiVersion"));
    expect(api?.fix, "the apiVersion remedy must name the expected value").toContain("personaxis.com/v1");

    // And the semantic one states the relation, with both live numbers in it.
    const uncertainty = validatePersona(validThenBroken()).errors.find((e) =>
      e.field.includes("uncertainty_policy"),
    );
    expect(uncertainty?.fix).toContain("0.9");
    expect(uncertainty?.fix).toContain("0.2");
  });

  it("a schema failure explains the missing field in the author's terms", () => {
    const result = validatePersona({ spec_version: "1.1.0" });
    expect(result.status).toBe("FAIL_SCHEMA");
    for (const e of result.errors) assertActionable(e.fix, `schema ${e.field}`);
    expect(result.errors.some((e) => /add the missing field/i.test(e.fix))).toBe(true);
  });
});

describe("every lint finding carries an actionable remedy (V7.B4)", () => {
  it("holds for the whole rule set at once", () => {
    const { findings } = runRules(brokenPersona());
    expect(findings.length).toBeGreaterThan(8);
    for (const f of findings) assertActionable(f.fix, `lint ${f.rule}@${f.path ?? "-"}`);
  });

  it("holds for a clean-ish persona too (warnings and infos, not just errors)", () => {
    const { findings } = runRules({
      apiVersion: "personaxis.com/v1",
      kind: "UserPersona",
      spec_version: "1.1.0",
      metadata: { name: "u", version: "1.0.0", description: "d", created: "2026-07-21" },
      identity: { canonical_id: "u" },
      values_and_drives: {},
      cognition: {},
      persona: {},
    });
    for (const f of findings) assertActionable(f.fix, `lint ${f.rule}`);
  });

  it("survives an unparseable file: even the parse error says what to look at", () => {
    const report = lint("not a persona at all");
    for (const f of report.findings) assertActionable(f.fix, `lint ${f.rule}`);
  });
});

/**
 * A remedy that names a command which does not exist is worse than no remedy: it
 * sends the reader to a dead end and costs them the trust they extended. Two of
 * mine did exactly that (`personaxis inspect memory`, `personaxis inspect audit`),
 * and only a dogfood caught it. Now the suite does.
 */
describe("every command a remedy names actually exists (V7.B4)", () => {
  // Read from the registration site rather than importing index.ts, which parses
  // argv on import. Same source the docs-parity suite uses.
  const indexSrc = readFileSync(join(__dirname, "..", "src", "index.ts"), "utf-8");
  const known = new Set([...indexSrc.matchAll(/addCommand\((\w+)Command/g)].map((m) => m[1]));

  function commandsCitedIn(text: string): string[] {
    // `personaxis <verb>` inside backticks or prose, first word only.
    return [...text.matchAll(/personaxis\s+([a-z][a-z-]*)/g)].map((m) => m[1]);
  }

  function assertCitedCommandsExist(text: string, label: string): void {
    for (const verb of commandsCitedIn(text)) {
      expect(known.has(verb), `${label}: remedy cites \`personaxis ${verb}\`, which is not a command`).toBe(true);
    }
  }

  it("holds across every lint finding", () => {
    for (const f of runRules(brokenPersona()).findings) assertCitedCommandsExist(f.fix, `lint ${f.rule}`);
    for (const f of lint("not a persona").findings) assertCitedCommandsExist(f.fix, `lint ${f.rule}`);
  });

  it("holds across every validator issue", () => {
    for (const pass of [validatePersona({ spec_version: "1.1.0" }), validatePersona(validThenBroken())]) {
      for (const i of [...pass.errors, ...pass.warnings]) assertCitedCommandsExist(i.fix, `validate ${i.field}`);
    }
  });

  it("holds across the doctor's own remedies", () => {
    const dir2 = mkdtempSync(join(tmpdir(), "pxs-doc-cite-"));
    try {
      const report = doctorChecksOffline(writeStarterPersona(dir2, "Vega"));
      assertCitedCommandsExist(report.lines.join("\n"), "doctor");
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});

describe("policy.yaml issues carry remedies too (V7.B4)", () => {
  it("covers the sign-off and assertion warnings", () => {
    const result = validatePolicy(
      {
        spec_version: "1.1.0",
        applies_to: { persona_name: "other" },
        // 'auto' is the deprecated alias the schema still accepts, and the one
        // the validator warns about: exactly the case that needs a remedy.
        improvement_policy: {
          mode: "auto",
          approved_by: "someone",
          last_approval_at: "2026-07-21T00:00:00Z",
          autonomous_scope_allowlist: ["persona.task_modes.*"],
        },
      },
      "mine",
    );
    const issues = [...result.errors, ...result.warnings];
    expect(issues.length).toBeGreaterThan(0);
    for (const i of issues) assertActionable(i.fix, `policy ${i.field}`);
    expect(result.errors.find((e) => e.field === "applies_to.persona_name")?.fix).toContain("mine");
  });
});

/** Applies the minimum edit for each reported field, so the next pass reaches the next category. */
function repairOnce(data: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const next = structuredClone(data);
  const set = (path: string, value: unknown): void => {
    const parts = path.split(".");
    let node = next as Record<string, unknown>;
    for (const part of parts.slice(0, -1)) {
      if (typeof node[part] !== "object" || node[part] === null) node[part] = {};
      node = node[part] as Record<string, unknown>;
    }
    node[parts[parts.length - 1]] = value;
  };
  for (const f of fields) {
    switch (f) {
      case "apiVersion":
        set("apiVersion", "personaxis.com/v1");
        break;
      case "affect.representation":
        set("affect.representation", "hybrid_dimensional_appraisal_discrete_mood");
        break;
      case "affect.regulation_policy.never_claim_real_feeling":
      case "persona.constraints.cannot_claim_real_emotion":
      case "persona.constraints.cannot_override_identity":
      case "persona.constraints.cannot_override_character":
      case "memory.deletion_policy.user_request_supported":
      case "values_and_drives.conflict_resolution.safety_over_completion":
        set(f, true);
        break;
      case "character.virtues.honesty.enforcement":
        set(f, "hard");
        break;
      case "values_and_drives.values.safety.weight":
        set(f, 0.95);
        break;
      case "values_and_drives.values.safety.type":
        set(f, "governance");
        break;
      case "self_regulation.hard_limits":
        set(f, [
          "No claim of subjective consciousness.",
          "No persistent memory write without policy pass.",
          "No unauthorized identity change.",
        ]);
        break;
      case "cognition.uncertainty_policy":
        set("cognition.uncertainty_policy.disclose_when_above", 0.2);
        set("cognition.uncertainty_policy.abstain_when_above", 0.6);
        break;
      default:
        break;
    }
  }
  return next;
}
