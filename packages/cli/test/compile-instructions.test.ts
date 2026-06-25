import { describe, it, expect } from "vitest";
import { buildCompilePrompt, buildDecompilePrompt, type CompileTargetInfo } from "../src/compile-instructions.js";

const target: CompileTargetInfo = {
  label: "root persona (repo-root PERSONA.md)",
  outputPath: "PERSONA.md",
  isSubagent: false,
};

describe("compile prompt — persona-prompting (v0.10)", () => {
  const p = buildCompilePrompt({ personaxisMd: "---\nx: 1\n---\n", resourceManifest: "- ./memory.md", target });

  it("instructs second-person role adoption + the persona-prompting devices", () => {
    expect(p).toMatch(/SECOND PERSON/);
    expect(p).toMatch(/role adoption/i);
    expect(p).toMatch(/scene contract/i);
    expect(p).toMatch(/voice exemplar/i);
    expect(p).toMatch(/break.?character/i);
  });

  it("folds applied self-edits as authoritative overrides when present", () => {
    const withOverlay = buildCompilePrompt({
      personaxisMd: "---\nx: 1\n---\n",
      resourceManifest: "- ./memory.md",
      target,
      appliedOverlay: { "persona_prompting.address.you_are": "You are X." },
    });
    expect(withOverlay).toMatch(/Applied self-edits/i);
    expect(withOverlay).toMatch(/you_are/);
  });
});

describe("decompile prompt — maps prose back to persona_prompting", () => {
  const p = buildDecompilePrompt({
    currentPersonaxisMd: "---\nx: 1\n---\n",
    editedCompiledMd: "# You are X\n",
    resourceManifest: "- ./memory.md",
    target: { ...target, outputPath: "PERSONA.md" },
  });

  it("contains the persona_prompting mapping rule and the safety guard", () => {
    expect(p).toMatch(/persona_prompting/);
    expect(p).toMatch(/voice_exemplars/);
    expect(p).toMatch(/scene_contracts/);
    expect(p).toMatch(/break_character_guardrails/);
    expect(p).toMatch(/[Nn]ever weaken a safety universal/);
  });
});
