/**
 * A polished document keeps the sections of the assembled one, and adds none.
 *
 * Measured 2026-10-07 on command-a-03-2025, compiling a rebuilt Clio: the polish passed the faithfulness
 * gate and ended with "## personaxis.md (register/voice reference only, introduces NO new facts)", which is
 * the heading of the reference block in its own prompt, followed by the source file's Overview, Design
 * Rationale and Resources sections. The gate compared claims inside the protected sections only, so whole
 * sections the model added were never looked at.
 */
import { describe, it, expect } from "vitest";
import { assemblePersonaDoc, checkFaithfulness } from "../src/index.js";

const assembled = assemblePersonaDoc({
  persona: {
    identity: { display_name: "Clio", system_identity: { purpose: "Keep the CLI honest." } },
    character: { prohibited_behaviors: ["Marking a failing check as passing."] },
    self_regulation: { hard_limits: ["No claim of subjective consciousness."] },
  },
  target: { name: "Clio", isSubagent: false, resourceBase: "./.personaxis/" },
});

describe("headings in a polished document", () => {
  it("accepts the assembled document itself", () => {
    expect(checkFaithfulness(assembled, assembled).ok).toBe(true);
  });

  it("rejects a polish that appends a section the assembled document does not have", () => {
    const leaked = `${assembled}\n\n## personaxis.md (register/voice reference only, introduces NO new facts)\n\n*Content omitted.*\n\n## Overview\n\nYou maintain the CLI.\n`;
    const report = checkFaithfulness(assembled, leaked);
    expect(report.ok).toBe(false);
    expect(report.findings.some((f) => f.kind === "invented" && /personaxis\.md \(register/.test(f.text))).toBe(true);
    expect(report.findings.some((f) => f.kind === "invented" && /^Overview$/.test(f.text))).toBe(true);
  });

  it("does not mind a heading written in a different case or spacing", () => {
    const recased = assembled.replace("## Who you are", "##  Who You Are");
    expect(checkFaithfulness(assembled, recased).ok).toBe(true);
  });
});
