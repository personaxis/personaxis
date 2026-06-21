import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "dist", "index.js");
const built = existsSync(CLI);

const FIX = `---
metadata: { name: t, version: 1.0.0 }
identity: { canonical_id: tester, display_name: Tester }
affect:
  baseline:
    mood:
      tone: { mean: 0.0, range: [-0.2, 0.2] }
---
Tester body.
`;

function run(args: string[], env: Record<string, string> = {}): string {
  return execFileSync("node", [CLI, ...args], {
    encoding: "utf-8",
    env: { ...process.env, FORCE_COLOR: "0", PERSONAXIS_NO_ANIM: "1", ...env },
  });
}

describe.skipIf(!built)("personaxis CLI (e2e against built dist)", () => {
  let home: string;
  let persona: string;
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "pxs-e2e-"));
    persona = join(home, "personaxis.md");
    writeFileSync(persona, FIX);
  });

  it("--version prints a semver", () => {
    expect(run(["--version"]).trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("sigil renders a differentiated, named sigil", () => {
    const out = run(["sigil", "--persona", persona]);
    expect(out).toContain("Tester");
    expect(out).toContain("sigil #");
    expect(out).toContain("voice");
  });

  it("overseer + team are distinct (collections vs teams)", () => {
    const env = { PERSONAXIS_HOME: home };
    run(["overseer", "register", "tester"], env);
    run(["team", "create", "squad", "--lead", "tester"], env);
    const show = run(["team", "show", "squad"], env);
    expect(show).toContain("squad");
    expect(show).toContain("lead");
    const ov = run(["overseer", "show"], env);
    expect(ov).toContain("teams");
    expect(ov).toContain("collections");
  });

  it("first-run onboarding scaffolds a VALID, playable starter persona", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pxs-onboard-"));
    const out = execFileSync("node", [CLI], {
      cwd,
      input: "hi there\n/exit\n",
      encoding: "utf-8",
      env: { ...process.env, FORCE_COLOR: "0", PERSONAXIS_NO_ANIM: "1" },
    });
    expect(out).toContain("is ready");
    expect(out).toContain("is awake");
    const created = join(cwd, ".personaxis", "personaxis.md");
    expect(existsSync(created)).toBe(true);
    // The starter must always validate (regression guard) — throws on non-zero exit.
    expect(() => run(["validate", created])).not.toThrow();
    rmSync(cwd, { recursive: true, force: true });
  });

  it("sync merges another machine's state without clobber (dry-run)", () => {
    const other = join(home, "other-state.json");
    writeFileSync(
      other,
      JSON.stringify({ schema_version: "0.7.0", persona_id: "t", persona_version: "1", values: { "mood.tone": 0.15 }, mutation_log: [] }),
    );
    const out = run(["sync", other, "--persona", persona, "--dry-run"]);
    expect(out).toContain("Reconcile");
  });
});

if (!built) {
  // Surface clearly in local runs where dist isn't built yet.
  describe("cli e2e", () => {
    it("skipped — run `pnpm --filter @personaxis/persona.md build` first", () => {
      expect(built).toBe(false);
    });
  });
}
