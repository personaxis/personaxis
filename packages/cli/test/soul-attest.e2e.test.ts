/**
 * V3.3 wedge e2e: a real SOUL.md imports into a VALID governed persona
 * (`create --from-import`, jacobian gate included), and `personaxis attest`
 * mints the local behavioral credential over it; `attest --check` goes not-live
 * on spec tamper and on expiry. Hermetic: PERSONAXIS_HOME points at a temp dir
 * so the machine's global model config never leaks in (offline heuristic path).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "dist", "index.js");
const built = existsSync(CLI);

const SOUL = `# SOUL

## Core Identity

You are Nyx, a nocturnal research assistant. Curious, precise, allergic to hype.

## Boundaries

- Never fabricate a citation
- Never claim to be human
`;

function run(args: string[], cwd: string, home: string): { code: number; out: string } {
  try {
    const out = execFileSync("node", [CLI, ...args], {
      cwd,
      encoding: "utf-8",
      env: {
        ...process.env,
        FORCE_COLOR: "0",
        PERSONAXIS_NO_ANIM: "1",
        PERSONAXIS_NO_UPDATE_CHECK: "1",
        PERSONAXIS_HOME: home,
      },
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}

describe.skipIf(!built)("SOUL.md import → governed persona → attest (V3.3)", () => {
  let dir: string;
  let home: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pxs-soulwedge-"));
    home = mkdtempSync(join(tmpdir(), "pxs-home-"));
    writeFileSync(join(dir, "SOUL.md"), SOUL, "utf-8");
  });

  it("creates a valid persona from SOUL.md and runs the attest lifecycle", { timeout: 120_000 }, () => {
    const created = run(["create", "nyx", "--from-import", "SOUL.md", "--yes"], dir, home);
    expect(created.code).toBe(0);
    const personaPath = join(dir, ".personaxis", "personas", "nyx", "personaxis.md");
    expect(existsSync(personaPath)).toBe(true);
    // The import carried the SOUL.md boundaries into the governed refusal surface.
    expect(readFileSync(personaPath, "utf-8")).toContain("Never fabricate a citation");

    // Mint the behavioral credential; the check reports LIVE.
    const minted = run(["attest", "--persona", personaPath], dir, home);
    expect(minted.code).toBe(0);
    expect(existsSync(join(dirname(personaPath), "personaxis.attest.json"))).toBe(true);
    const live = run(["attest", "--check", "--persona", personaPath], dir, home);
    expect(live.code).toBe(0);
    expect(live.out).toContain("ATTESTATION LIVE");

    // Tampering with the spec kills the credential (exit 1).
    appendFileSync(personaPath, "\n# tampered\n");
    const dead = run(["attest", "--check", "--persona", personaPath], dir, home);
    expect(dead.code).toBe(1);
    expect(dead.out).toContain("NOT LIVE");
  });

  it("an expired credential is not live", { timeout: 120_000 }, () => {
    const created = run(["create", "nyx", "--from-import", "SOUL.md", "--yes"], dir, home);
    expect(created.code).toBe(0);
    const personaPath = join(dir, ".personaxis", "personas", "nyx", "personaxis.md");
    expect(run(["attest", "--persona", personaPath, "--ttl", "0"], dir, home).code).toBe(0);
    const r = run(["attest", "--check", "--persona", personaPath], dir, home);
    expect(r.code).toBe(1);
    expect(r.out).toContain("EXPIRED");
  });

  it("attest refuses to mint over an invalid persona (exit 2)", { timeout: 120_000 }, () => {
    const bad = join(dir, "personaxis.md");
    writeFileSync(bad, "---\napiVersion: personaxis.com/v1\nkind: AgentPersona\nspec_version: \"1.1.0\"\nmetadata: { name: t, version: 1.0.0 }\n---\nbody\n");
    const r = run(["attest", "--persona", bad], dir, home);
    expect(r.code).toBe(2);
    expect(r.out).toContain("does not validate");
  });
});
