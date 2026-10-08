import { describe, it, expect } from "vitest";
import { buildWritePrompt, buildDecompilePrompt, type CompileTargetInfo } from "../src/compile-instructions.js";

const target: CompileTargetInfo = {
  label: "root persona (repo-root PERSONA.md)",
  outputPath: "PERSONA.md",
  isSubagent: false,
};

describe("the prompt a model writes PERSONA.md from", () => {
  const reference = "# You are X\n\n## Who you are\n\nX.\n\n## Hard limits (never overridden)\n\n- No claim of subjective consciousness.\n\n## Memory & resources\n\n- `./memory.md`, your semantic memory\n";
  const p = buildWritePrompt({ reference, personaxisMd: "---\nx: 1\n---\n", target });

  it("asks for the work first, traits only as behaviour, reasons from the spec, and a normal tone", () => {
    expect(p).toMatch(/second person/);
    expect(p).toMatch(/The work first/);
    expect(p).toMatch(/Never as labels, levels or\s+numbers/);
    expect(p).toMatch(/never invent a reason or a fact/);
    expect(p).toMatch(/no CRITICAL, no capitalised NEVER or ALWAYS/);
    expect(p).toMatch(/Write no new ones/);
  });

  it("names the exact headings it may use, taken from the reference, and what the check enforces", () => {
    expect(p).toContain('"Who you are", "Hard limits (never overridden)", "Memory & resources"');
    expect(p).toMatch(/every bullet of the reference must survive/);
    expect(p).toMatch(/"Memory & resources" bullets word for word/);
  });

  it("carries the reference and the spec, and says the reference wins when it folds self-edits", () => {
    expect(p).toContain("- No claim of subjective consciousness.");
    expect(p).toContain("x: 1");
    expect(p).not.toMatch(/reference wins/);
    expect(buildWritePrompt({ reference, personaxisMd: "x", target, overlaid: true })).toMatch(/the reference wins/);
  });
});

describe("decompile prompt, maps prose back to persona_prompting", () => {
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
