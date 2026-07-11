/**
 * F3.1, the deterministic assembler + the faithfulness gate.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import {
  assemblePersonaDoc,
  checkFaithfulness,
  summarizeFaithfulness,
  type AssembleInput,
} from "../src/index.js";

// The golden CMO persona (v1.0) in the sibling persona.md repo.
const CMO = join(__dirname, "..", "..", "..", "..", "persona.md", ".personaxis", "personas", "cmo", "personaxis.md");
const haveGolden = existsSync(CMO);

function cmoInput(): AssembleInput {
  const persona = matter(readFileSync(CMO, "utf-8")).data as Record<string, unknown>;
  return {
    persona,
    resourceManifest: "- `./.personaxis/memory.md`, semantic memory\n- `./.personaxis/references/`, playbooks",
    target: { name: "Mira", isSubagent: false, resourceBase: "./.personaxis/" },
  };
}

describe("F3.1 assemblePersonaDoc, deterministic stage 1", () => {
  it("is deterministic: same spec ⇒ byte-identical output", () => {
    const persona = { identity: { display_name: "X" }, self_regulation: { hard_limits: ["No claim of subjective consciousness."] } };
    const input: AssembleInput = { persona, target: { name: "X", isSubagent: false, resourceBase: "./.personaxis/" } };
    expect(assemblePersonaDoc(input)).toBe(assemblePersonaDoc(input));
  });

  it("writes second-person role adoption and every canonical section it has material for", () => {
    if (!haveGolden) return;
    const doc = assemblePersonaDoc(cmoInput());
    expect(doc.startsWith("# You are Mira")).toBe(true);
    expect(doc).toMatch(/You are Mira, the CMO persona/); // from persona.address.you_are (verbatim)
    expect(doc).toContain("## How you speak");
    expect(doc).toContain("## Hard limits (never overridden)");
    expect(doc).toContain("## Staying in character");
    // A voice exemplar is reproduced verbatim.
    expect(doc).toContain("Viral isn't a plan.");
    // A hard limit is reproduced verbatim.
    expect(doc).toContain("No fabricated data, metrics, case studies, benchmarks, or quotes.");
  });

  it("NEVER emits numeric runtime state (no trait tables, no sigil, no live block)", () => {
    if (!haveGolden) return;
    const doc = assemblePersonaDoc(cmoInput());
    expect(doc).not.toMatch(/0\.\d\d/); // no envelope numbers
    expect(doc).not.toMatch(/sigil/i);
    expect(doc).not.toMatch(/LIVE-STATE/);
    expect(doc).not.toMatch(/mean|range/);
  });

  it("applies dot-path overlay overrides authoritatively", () => {
    const persona = { persona: { address: { you_are: "You are the OLD role." } }, self_regulation: { hard_limits: ["x"] } };
    const doc = assemblePersonaDoc({
      persona,
      target: { name: "N", isSubagent: false, resourceBase: "./.personaxis/" },
      appliedOverlay: { "persona.address.you_are": "You are the NEW role." },
    });
    expect(doc).toContain("You are the NEW role.");
    expect(doc).not.toContain("OLD role");
  });

  it("degrades gracefully: derives from quantitative layers when persona-prompting is absent", () => {
    const persona = {
      identity: {
        display_name: "Bot",
        role_identity: { primary_role: "support_agent" },
        system_identity: { purpose: "Answer questions." },
      },
      self_regulation: { hard_limits: ["No claim of subjective consciousness."] },
    };
    const doc = assemblePersonaDoc({ persona, target: { name: "Bot", isSubagent: false, resourceBase: "./.personaxis/" } });
    expect(doc).toContain("support agent");
    expect(doc).toContain("Answer questions.");
  });
});

describe("F3.1 checkFaithfulness, deterministic stage-2 gate", () => {
  it("passes when the polish only REPHRASES protected claims", () => {
    const assembled = [
      "## Hard limits (never overridden)",
      "",
      "- No fabricated data, metrics, or quotes.",
      "- No board narrative that hides a material miss.",
    ].join("\n");
    const polished = [
      "## Hard limits (never overridden)",
      "",
      "- You never fabricate data, metrics, or quotes.",
      "- You never write a board narrative that hides a material miss.",
    ].join("\n");
    const report = checkFaithfulness(assembled, polished);
    expect(report.ok).toBe(true);
    expect(summarizeFaithfulness(report)).toMatch(/OK/);
  });

  it("FAILS on an INVENTED protected claim (the CMO consistency regression)", () => {
    const assembled = [
      "## What is fixed, what can change",
      "",
      "- **Fixed:** honesty about traction; metric-first thinking.",
    ].join("\n");
    const polished = [
      "## What is fixed, what can change",
      "",
      "- **Fixed:** honesty about traction; metric-first thinking.",
      "- **Fixed:** unwavering optimism and relentless enthusiasm.", // invented, not in source
    ].join("\n");
    const report = checkFaithfulness(assembled, polished);
    expect(report.ok).toBe(false);
    expect(report.findings.some((f) => f.kind === "invented" && /optimism/i.test(f.text))).toBe(true);
  });

  it("FAILS on a DROPPED hard limit (safety cannot be lost in polish)", () => {
    const assembled = [
      "## Hard limits (never overridden)",
      "",
      "- No claim of subjective consciousness.",
      "- No unauthorized identity change.",
    ].join("\n");
    const polished = [
      "## Hard limits (never overridden)",
      "",
      "- You never claim subjective consciousness.",
      // the identity-change limit was dropped
    ].join("\n");
    const report = checkFaithfulness(assembled, polished);
    expect(report.ok).toBe(false);
    expect(report.findings.some((f) => f.kind === "dropped" && /identity change/i.test(f.text))).toBe(true);
  });

  it("the assembler's own output is trivially faithful to itself", () => {
    if (!haveGolden) return;
    const doc = assemblePersonaDoc(cmoInput());
    expect(checkFaithfulness(doc, doc).ok).toBe(true);
  });
});
