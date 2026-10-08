/**
 * Creation tells the truth about the model: without one it refuses, with one that cannot be reached it
 * fails naming the reason, and a PERSONA.md the faithfulness check rejects is never written or reported.
 *
 * Until 2026-10-07 creation without a model wrote a persona from labeled defaults, and a rejected or
 * failed polish wrote the assembled template as PERSONA.md; before that, `runCompile` returned `void` and
 * creation printed "compiled + LLM polished" over a template the check had rejected. Now every field and
 * the document are a model's (H15): no model means no persona, and a rejected document means no document,
 * said plainly, with the definition (valid) left to compile again.
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

  it("with a model that writes the document: PERSONA.md is the model's, checked, and says so", async () => {
    model = await startFakeModel();
    const r = await create(modelEnv(model));
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("(written by the model, checked against the definition)");
    const compiled = readFileSync(join(personaDir(), "PERSONA.md"), "utf-8");
    expect(compiled).toContain("# You are Terse Code Reviewer");
    expect(compiled).not.toContain("stage-1");
    // The version is in the persona's history, with why it was written.
    const history = await runCli(CLI, ["compile", "rev", "--history"], { cwd: dir, env: { PERSONAXIS_HOME: home } });
    expect(history.out).toContain("creation");
    expect(history.out).toContain("fake");
  }, 60_000);

  it("with a model whose document is rejected: no PERSONA.md, the reason said, exit 1, the definition valid", async () => {
    // The fake model authors the stages from a recorded real run, and answers the document with a line the
    // faithfulness check rejects, every time it is asked.
    model = await startFakeModel({ document: "Hello." });
    const r = await create(modelEnv(model));
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain("PERSONA.md was not written");
    expect(r.out).toContain("failed the faithfulness check 3 times");
    expect(r.out).toContain("finish: personaxis compile rev");
    expect(existsSync(join(personaDir(), "PERSONA.md"))).toBe(false);
    // What the model wrote is kept where no host loads it, to read.
    expect(readFileSync(join(dir, ".personaxis", ".tmp", "rejected-PERSONA.md"), "utf-8")).toContain("Hello.");

    const validate = await runCli(CLI, ["validate", join(personaDir(), "personaxis.md")], { cwd: dir, env: { PERSONAXIS_HOME: home } });
    expect(validate.out).toContain("PASS");
  }, 60_000);
});
