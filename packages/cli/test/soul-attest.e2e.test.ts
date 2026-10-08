/**
 * V3.3 wedge e2e: a real SOUL.md imports into a VALID governed persona
 * (`create --from-import`, jacobian gate included), and `personaxis attest`
 * mints the local behavioral credential over it; `attest --check` goes not-live
 * on spec tamper and on expiry. Hermetic: PERSONAXIS_HOME points at a temp dir
 * so the machine's global model config never leaks in, and the model is the
 * local fake, which answers each Genesis stage from a recorded real run. What
 * the persona SAYS is therefore the recording's; what is under test is that an
 * import becomes a cited source and the result can be attested.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { modelEnv, runCli, startFakeModel, type FakeModel } from "./helpers/fake-model.js";

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

// Async, like every run here: a synchronous child blocks this worker, which also serves the fake model.
const run = (args: string[], cwd: string, home: string) =>
  runCli(CLI, args, { cwd, env: { PERSONAXIS_NO_ANIM: "1", PERSONAXIS_HOME: home } });

describe.skipIf(!built)("SOUL.md import → governed persona → attest (V3.3)", () => {
  let dir: string;
  let home: string;
  let model: FakeModel;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "pxs-soulwedge-"));
    home = mkdtempSync(join(tmpdir(), "pxs-home-"));
    writeFileSync(join(dir, "SOUL.md"), SOUL, "utf-8");
    model = await startFakeModel();
  });
  afterEach(() => model.close());

  const create = () =>
    runCli(CLI, ["create", "nyx", "--from-import", "SOUL.md", "--yes"], {
      cwd: dir,
      env: { PERSONAXIS_NO_ANIM: "1", PERSONAXIS_HOME: home, ...modelEnv(model) },
    });

  it("creates a valid persona from SOUL.md and runs the attest lifecycle", { timeout: 120_000 }, async () => {
    const created = await create();
    expect(created.code, created.out).toBe(0);
    const personaPath = join(dir, ".personaxis", "personas", "nyx", "personaxis.md");
    expect(existsSync(personaPath)).toBe(true);
    // The import is a numbered source the model read, listed in the persona.
    // The folder (S1) lists SOUL.md in its tree; its text is read once, as the import (S2).
    expect(readFileSync(personaPath, "utf-8")).toContain("- S2: SOUL.md (soul-md)");
    expect(JSON.stringify(model.requests[0]).split("Never fabricate a citation").length - 1).toBe(1);
    // And the model was handed the whole file, boundaries included.
    expect(JSON.stringify(model.requests[0])).toContain("Never fabricate a citation");

    // Mint the behavioral credential; the check reports LIVE.
    const minted = await run(["attest", "--persona", personaPath], dir, home);
    expect(minted.code).toBe(0);
    expect(existsSync(join(dirname(personaPath), "personaxis.attest.json"))).toBe(true);
    const live = await run(["attest", "--check", "--persona", personaPath], dir, home);
    expect(live.code).toBe(0);
    expect(live.out).toContain("ATTESTATION LIVE");

    // Tampering with the spec kills the credential (exit 1).
    appendFileSync(personaPath, "\n# tampered\n");
    const dead = await run(["attest", "--check", "--persona", personaPath], dir, home);
    expect(dead.code).toBe(1);
    expect(dead.out).toContain("NOT LIVE");
  });

  it("an expired credential is not live", { timeout: 120_000 }, async () => {
    const created = await create();
    expect(created.code, created.out).toBe(0);
    const personaPath = join(dir, ".personaxis", "personas", "nyx", "personaxis.md");
    expect((await run(["attest", "--persona", personaPath, "--ttl", "0"], dir, home)).code).toBe(0);
    const r = await run(["attest", "--check", "--persona", personaPath], dir, home);
    expect(r.code).toBe(1);
    expect(r.out).toContain("EXPIRED");
  });

  it("attest refuses to mint over an invalid persona (exit 2)", { timeout: 120_000 }, async () => {
    const bad = join(dir, "personaxis.md");
    writeFileSync(bad, "---\napiVersion: personaxis.com/v1\nkind: AgentPersona\nspec_version: \"1.1.0\"\nmetadata: { name: t, version: 1.0.0 }\n---\nbody\n");
    const r = await run(["attest", "--persona", bad], dir, home);
    expect(r.code).toBe(2);
    expect(r.out).toContain("does not validate");
  });
});
