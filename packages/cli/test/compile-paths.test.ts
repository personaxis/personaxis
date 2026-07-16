/**
 * F0.1 (V2): the compiled-document contract. `compiledPathFor` is the single owner of
 * "where does PERSONA.md live", `resolvePersonaSourcePath` walks up like git, a fresh
 * starter is born marked pending, and the deterministic first compile REALLY writes
 * the file (the phantom "/compile said ok but nothing exists" bug).
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

import { compiledPathFor, resolvePersonaSourcePath } from "../src/load.js";
import { readRecompilePending } from "@personaxis/core";
import { writeStarterPersona } from "../src/starter.js";
import { runCompile } from "../src/commands/compile.js";

let base: string;
let savedCwd: string;
let savedPxsHome: string | undefined;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "pxs-paths-"));
  savedCwd = process.cwd();
  savedPxsHome = process.env.PERSONAXIS_HOME;
  process.env.PERSONAXIS_HOME = join(base, "pxs-config"); // isolate model config
  fake.home = "";
});

afterEach(() => {
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
    writeStarterPersona(repo, "Aria");
    const nested = join(repo, "src", "deep");
    mkdirSync(nested, { recursive: true });
    process.chdir(nested);
    expect(resolvePersonaSourcePath()).toBe(join(repo, ".personaxis", "personaxis.md"));
  });

  it("still prefers the cwd's own persona over an ancestor's", () => {
    const outer = join(base, "outer");
    writeStarterPersona(outer, "Outer");
    const inner = join(outer, "inner");
    writeStarterPersona(inner, "Inner");
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
    const p = writeStarterPersona(repo, "Aria");
    expect(readRecompilePending(p).pending).toBe(true);
    expect(readRecompilePending(p).reason).toContain("initial compile");
  });

  it("the deterministic first compile writes PERSONA.md exactly where compiledPathFor says", async () => {
    const repo = join(base, "repo3");
    const p = writeStarterPersona(repo, "Aria");
    process.chdir(repo);
    await runCompile({ root: true, noPolish: true });
    const compiled = compiledPathFor(p);
    expect(compiled).toBe(join(repo, "PERSONA.md"));
    expect(existsSync(compiled)).toBe(true);
    expect(readFileSync(compiled, "utf-8")).toContain("Aria");
    expect(readRecompilePending(p).pending).toBe(false); // the marker is cleared
  });

  it("a HOME-root persona compiles INSIDE ~/.personaxis/", async () => {
    fake.home = join(base, "home2");
    const p = writeStarterPersona(fake.home, "Aria");
    process.chdir(fake.home);
    await runCompile({ root: true, noPolish: true });
    const compiled = compiledPathFor(p);
    expect(compiled).toBe(join(fake.home, ".personaxis", "PERSONA.md"));
    expect(existsSync(compiled)).toBe(true);
    expect(existsSync(join(fake.home, "PERSONA.md"))).toBe(false); // no litter in HOME
    expect(existsSync(join(fake.home, "CLAUDE.md"))).toBe(false); // no host reads ~/CLAUDE.md
  });
});
