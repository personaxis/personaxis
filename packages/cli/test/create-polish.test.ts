/**
 * Creation tells the truth about the model: without one it refuses, with one that cannot be reached it
 * fails naming the reason, and a polish the model did not do is never reported as done.
 *
 * Until 2026-10-07 creation without a model wrote a persona from labeled defaults; now every field is
 * authored by a model (H15), so no model means no persona, and nothing is written. The polish half pins an
 * older bug: `runCompile` returned `void`, so "it did not throw" was read as "a model rewrote it", and
 * creation printed "compiled + LLM polished" over a template the faithfulness gate had rejected.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { modelEnv, runCli, startFakeModel, type FakeModel } from "./helpers/fake-model.js";

const CLI = join(process.cwd(), "dist", "index.js");
const BRIEF = "A terse code reviewer that never softens findings";

let dir: string;
let home: string;
let model: FakeModel | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pxs-create-polish-"));
  home = mkdtempSync(join(tmpdir(), "pxs-create-home-"));
});
afterEach(async () => {
  await model?.close();
  model = undefined;
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const personaDir = () => join(dir, ".personaxis", "personas", "rev");
const create = (env: Record<string, string>) =>
  runCli(CLI, ["create", "rev", "--from-prompt", BRIEF, "--yes"], { cwd: dir, env: { PERSONAXIS_HOME: home, ...env } });

describe("create tells the truth about the model", () => {
  it("with NO model: refuses, says how to configure one, and writes nothing", async () => {
    // An isolated PERSONAXIS_HOME means no global profile resolves.
    const r = await create({ PERSONAXIS_ENDPOINT: "", PERSONAXIS_MODEL: "", PERSONAXIS_API_KEY: "" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("Creating a persona needs a model, and none is configured");
    expect(r.out).toContain("PERSONAXIS_ENDPOINT");
    expect(existsSync(personaDir())).toBe(false);
  }, 60_000);

  it("with a model that CANNOT be reached: fails, names the reason, and writes nothing", async () => {
    // Port 9 (discard) refuses fast, so this exercises the provider-failure path without the network.
    const r = await create({ PERSONAXIS_ENDPOINT: "http://127.0.0.1:9/v1", PERSONAXIS_MODEL: "ghost", PERSONAXIS_API_KEY: "x" });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/Error:/);
    expect(existsSync(join(personaDir(), "personaxis.md"))).toBe(false);
  }, 60_000);

  it("with a model whose rewrite is rejected: a valid persona, and the polish is reported as NOT done", async () => {
    // The fake model authors the stages from a recorded real run, and answers the polish with a line the
    // faithfulness gate rejects.
    model = await startFakeModel();
    const r = await create(modelEnv(model));
    expect(r.code, r.out).toBe(0);
    expect(r.out).not.toContain("compiled + LLM polished");
    expect(r.out).toContain("NOT polished by a model, though one is configured");
    const compiled = readFileSync(join(personaDir(), "PERSONA.md"), "utf-8");
    expect(compiled).toContain("stage-1 template, not polished by a model");

    const validate = await runCli(CLI, ["validate", join(personaDir(), "personaxis.md")], { cwd: dir, env: { PERSONAXIS_HOME: home } });
    expect(validate.out).toContain("PASS");
  }, 60_000);
});
