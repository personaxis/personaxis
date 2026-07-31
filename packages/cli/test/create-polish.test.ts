/**
 * Creation must not hand back a template while claiming a model wrote it.
 *
 * The stage-1 assembler echoes the answers back almost verbatim, language included, so a
 * persona created with a model configured has to pass through that model. Template output
 * is a legitimate result ONLY when no model is reachable, and it is marked in the file.
 *
 * The bug this pins: `runCompile` returned `void`, so "it did not throw" was read as "a
 * model rewrote it". Whenever the faithfulness gate rejected the model's rewrite, or the
 * provider was unreachable, creation still printed "compiled + LLM polished" over a
 * template. A caller cannot report honestly about a step whose outcome it never receives.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const CLI = join(process.cwd(), "dist", "index.js");

let dir: string;
let home: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pxs-create-polish-"));
  home = mkdtempSync(join(tmpdir(), "pxs-create-home-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

/** Run `create` in an isolated project + home, capturing stdout and stderr together. */
function create(env: Record<string, string> = {}): { out: string; compiled: string } {
  // spawnSync, not execFileSync: the loud failure is written to STDERR on purpose, and
  // execFileSync returns stdout only, which would let this test pass while the message
  // that matters went unchecked.
  const r = spawnSync(
    process.execPath,
    [CLI, "create", "rev", "--from-prompt", "A terse code reviewer that never softens findings", "--yes"],
    {
      cwd: dir,
      encoding: "utf-8",
      env: { ...process.env, PERSONAXIS_HOME: home, ...env },
    },
  );
  const out = `${r.stdout ?? ""}
${r.stderr ?? ""}`;
  const compiledPath = join(dir, ".personaxis", "personas", "rev", "PERSONA.md");
  return { out, compiled: existsSync(compiledPath) ? readFileSync(compiledPath, "utf-8") : "" };
}

describe("create reports the polish truthfully", () => {
  it("with NO model: writes the template, marks WHY, and does not claim a polish", () => {
    // An isolated PERSONAXIS_HOME means no global profile resolves.
    const { out, compiled } = create({
      PERSONAXIS_ENDPOINT: "",
      PERSONAXIS_MODEL: "",
      PERSONAXIS_API_KEY: "",
    });
    expect(compiled).toContain("stage-1 template, not polished by a model");
    expect(compiled).toContain("no model configured");
    expect(out).not.toContain("LLM polished");
    // This is an expected outcome, not a defect: no loud failure.
    expect(out).not.toContain("NOT polished by a model, though one is configured");
  }, 60_000);

  // Spawns the real CLI, which walks the whole Genesis pipeline; generous but bounded.
  it("with a model that CANNOT be reached: fails loudly and names the real reason", () => {
    // Port 9 (discard) refuses fast, so this exercises the provider-failure path without
    // depending on the network.
    const { out, compiled } = create({
      PERSONAXIS_ENDPOINT: "http://127.0.0.1:9/v1",
      PERSONAXIS_MODEL: "ghost",
      PERSONAXIS_API_KEY: "x",
    });
    // The summary must NOT present a template as a polished document.
    expect(out).not.toContain("compiled + LLM polished");
    expect(out).toContain("stage-1 template, NOT polished");
    // The failure is stated, with the reason carried up from the provider.
    expect(out).toContain("NOT polished by a model, though one is configured");
    expect(out).toMatch(/reason:\s+provider unavailable/);
    // And the file says the same thing, so it is still true when read later.
    expect(compiled).toContain("stage-1 template, not polished by a model");
    expect(compiled).toContain("provider unavailable");
  }, 60_000);

  it("the persona itself is still valid: a failed polish never leaves a broken spec", () => {
    create({ PERSONAXIS_ENDPOINT: "http://127.0.0.1:9/v1", PERSONAXIS_MODEL: "ghost", PERSONAXIS_API_KEY: "x" });
    const spec = join(dir, ".personaxis", "personas", "rev", "personaxis.md");
    expect(existsSync(spec)).toBe(true);
    const validate = execFileSync(process.execPath, [CLI, "validate", spec], {
      encoding: "utf-8",
      env: { ...process.env, PERSONAXIS_HOME: home },
    });
    expect(validate).toContain("PASS");
  }, 60_000);
});
