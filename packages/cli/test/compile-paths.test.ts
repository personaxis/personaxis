/**
 * F0.1 (V2): the compiled-document contract. `compiledPathFor` is the single owner of
 * "where does PERSONA.md live", `resolvePersonaSourcePath` walks up like git, a fresh
 * starter is born marked pending, and the first compile REALLY writes the file (the
 * phantom "/compile said ok but nothing exists" bug). Since 2026-10-07 a model writes
 * it; the test model here answers with the persona's own reference, which passes the
 * faithfulness check, so what is tested is where the file lands.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Controllable homedir: empty → the real one; set per test to fake a HOME-root persona.
const fake = vi.hoisted(() => ({ home: "" }));
vi.mock("os", async (importOriginal) => {
  const mod = await importOriginal<typeof import("os")>();
  return { ...mod, homedir: () => fake.home || mod.homedir() };
});

import { compiledPathFor, loadPersonaFile, resolvePersonaSourcePath } from "../src/load.js";
import { assemblePersonaDoc, readRecompilePending } from "@personaxis/core";
import { writeTestPersona } from "./helpers/test-persona.js";
import { runCompile } from "../src/commands/compile.js";
import { assembleInputFor } from "../src/compiled-document.js";
import { modelEnv, startFakeModel, type FakeModel } from "./helpers/fake-model.js";

let base: string;
let savedCwd: string;
let savedPxsHome: string | undefined;
let model: FakeModel | undefined;
const savedModelEnv: Record<string, string | undefined> = {};

/** A model for this process that answers a compile with the persona's own reference. */
async function modelWritingItsReference(personaPath: string): Promise<void> {
  const data = loadPersonaFile(personaPath).data as Record<string, unknown>;
  model = await startFakeModel({ document: assemblePersonaDoc(assembleInputFor(personaPath, data)) });
  for (const [k, v] of Object.entries(modelEnv(model))) {
    savedModelEnv[k] = process.env[k];
    process.env[k] = v;
  }
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "pxs-paths-"));
  savedCwd = process.cwd();
  savedPxsHome = process.env.PERSONAXIS_HOME;
  process.env.PERSONAXIS_HOME = join(base, "pxs-config"); // isolate model config
  fake.home = "";
});

afterEach(async () => {
  await model?.close();
  model = undefined;
  for (const [k, v] of Object.entries(savedModelEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  process.chdir(savedCwd);
  if (savedPxsHome === undefined) delete process.env.PERSONAXIS_HOME;
  else process.env.PERSONAXIS_HOME = savedPxsHome;
  fake.home = "";
  rmSync(base, { recursive: true, force: true });
});

describe("compiledPathFor (single owner of the compiled-doc location)", () => {
  it("root persona in a project → PERSONA.md one level above .personaxis/", () => {
    const p = join(base, "repo", ".personaxis", "personaxis.md");
    expect(compiledPathFor(p)).toBe(join(base, "repo", "PERSONA.md"));
  });

  it("sub-persona → PERSONA.md inside its own folder", () => {
    const p = join(base, "repo", ".personaxis", "personas", "cmo", "personaxis.md");
    expect(compiledPathFor(p)).toBe(join(base, "repo", ".personaxis", "personas", "cmo", "PERSONA.md"));
  });

  it("root persona in the user's HOME → ~/.personaxis/PERSONA.md (never litter the home dir)", () => {
    fake.home = join(base, "home");
    const p = join(fake.home, ".personaxis", "personaxis.md");
    expect(compiledPathFor(p)).toBe(join(fake.home, ".personaxis", "PERSONA.md"));
  });
});

describe("resolvePersonaSourcePath walk-up (git-like)", () => {
  it("finds the root spec from a nested subdirectory", () => {
    const repo = join(base, "repo");
    writeTestPersona(repo, "Aria");
    const nested = join(repo, "src", "deep");
    mkdirSync(nested, { recursive: true });
    process.chdir(nested);
    expect(resolvePersonaSourcePath()).toBe(join(repo, ".personaxis", "personaxis.md"));
  });

  it("still prefers the cwd's own persona over an ancestor's", () => {
    const outer = join(base, "outer");
    writeTestPersona(outer, "Outer");
    const inner = join(outer, "inner");
    writeTestPersona(inner, "Inner");
    process.chdir(inner);
    expect(resolvePersonaSourcePath()).toBe(join(inner, ".personaxis", "personaxis.md"));
  });

  it("names the searched locations when nothing exists anywhere", () => {
    // A tmp subtree with no .personaxis all the way up is not guaranteed (the real
    // home may have one), so only assert the error mentions the walk-up when thrown.
    const empty = join(base, "empty", "a", "b");
    mkdirSync(empty, { recursive: true });
    process.chdir(empty);
    try {
      const found = resolvePersonaSourcePath();
      expect(found.replace(/\\/g, "/")).toContain(".personaxis/personaxis.md"); // an ancestor's (e.g. the real home)
    } catch (e) {
      expect((e as Error).message).toContain("ancestor");
    }
  });
});

describe("starter + first compile (the phantom-compile bug)", () => {
  it("a fresh starter is marked recompile-pending", () => {
    const repo = join(base, "repo2");
    const p = writeTestPersona(repo, "Aria");
    expect(readRecompilePending(p).pending).toBe(true);
    expect(readRecompilePending(p).reason).toContain("initial compile");
  });

  it("the first compile writes PERSONA.md exactly where compiledPathFor says", async () => {
    const repo = join(base, "repo3");
    const p = writeTestPersona(repo, "Aria");
    process.chdir(repo);
    await modelWritingItsReference(p);
    await runCompile({ root: true, quiet: true });
    const compiled = compiledPathFor(p);
    expect(compiled).toBe(join(repo, "PERSONA.md"));
    expect(existsSync(compiled)).toBe(true);
    expect(readFileSync(compiled, "utf-8")).toContain("Aria");
    expect(readRecompilePending(p).pending).toBe(false); // the marker is cleared
  });

  it("a HOME-root persona compiles INSIDE ~/.personaxis/", async () => {
    fake.home = join(base, "home2");
    const p = writeTestPersona(fake.home, "Aria");
    process.chdir(fake.home);
    await modelWritingItsReference(p);
    await runCompile({ root: true, quiet: true });
    const compiled = compiledPathFor(p);
    expect(compiled).toBe(join(fake.home, ".personaxis", "PERSONA.md"));
    expect(existsSync(compiled)).toBe(true);
    expect(existsSync(join(fake.home, "PERSONA.md"))).toBe(false); // no litter in HOME
    expect(existsSync(join(fake.home, "CLAUDE.md"))).toBe(false); // no host reads ~/CLAUDE.md
  });
});
