/**
 * V4.3 / V6.9: the root baseline reaches every context file the project
 * actually has. GEMINI.md and .github/copilot-instructions.md are refreshed
 * when present and NEVER created (no litter); CLAUDE.md is created only when
 * neither CLAUDE.md nor AGENTS.md exists (the pre-V4.3 behavior, unchanged).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { injectRootBaselines } from "../src/commands/compile.js";

let dir: string;
let prevCwd: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pxs-baseline-"));
  prevCwd = process.cwd();
  process.chdir(dir);
});
afterEach(() => {
  process.chdir(prevCwd);
  rmSync(dir, { recursive: true, force: true });
});

describe("injectRootBaselines (V4.3)", () => {
  it("refreshes GEMINI.md and copilot-instructions.md when they exist", () => {
    writeFileSync(join(dir, "CLAUDE.md"), "# my project\n", "utf-8");
    writeFileSync(join(dir, "GEMINI.md"), "# gemini context\n", "utf-8");
    mkdirSync(join(dir, ".github"), { recursive: true });
    writeFileSync(join(dir, ".github", "copilot-instructions.md"), "# copilot\n", "utf-8");

    injectRootBaselines();

    for (const f of ["CLAUDE.md", "GEMINI.md", join(".github", "copilot-instructions.md")]) {
      const text = readFileSync(join(dir, f), "utf-8");
      expect(text, f).toContain("PERSONA:BASELINE");
      expect(text, f).toContain("@PERSONA.md");
    }
    // Idempotent: a second run keeps exactly one block.
    injectRootBaselines();
    const twice = readFileSync(join(dir, "GEMINI.md"), "utf-8");
    expect(twice.split("PERSONA:BASELINE:BEGIN").length).toBe(2); // one marker
  });

  it("never CREATES the secondary host files", () => {
    writeFileSync(join(dir, "AGENTS.md"), "# agents\n", "utf-8");
    injectRootBaselines();
    expect(existsSync(join(dir, "GEMINI.md"))).toBe(false);
    expect(existsSync(join(dir, ".github", "copilot-instructions.md"))).toBe(false);
    expect(readFileSync(join(dir, "AGENTS.md"), "utf-8")).toContain("PERSONA:BASELINE");
  });
});
