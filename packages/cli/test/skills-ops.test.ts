/**
 * V7.A5: "/skills su menu no funciona para nada... no funciona el enter apply ni el p
 * pull, tampoco hay forma de agregar skills o de actualizar los que ya existen".
 *
 * The view had no engine behind it. These are the real operations it now calls, which
 * the external subcommands share: declare, materialize, refresh, stop declaring.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { writeStarterPersona } from "../src/starter.js";
import { listSkills, addSkill, pullSkill, updateSkill, removeSkill } from "../src/repl/views/skills-data.js";

let dir: string;
let personaPath: string;
let baseDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pxs-skills-"));
  personaPath = writeStarterPersona(dir, "Vega");
  baseDir = dirname(personaPath);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function makeSource(name: string, body = "# how to research\n"): string {
  const src = join(baseDir, "sources", name);
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "SKILL.md"), body, "utf-8");
  return `./sources/${name}`;
}

describe("skill operations (V7.A5)", () => {
  it("a fresh persona declares no skills, and the list says so instead of failing", () => {
    expect(listSkills(personaPath)).toEqual([]);
  });

  it("adds a local skill and it shows up in the list", () => {
    const ref = makeSource("research");
    const r = addSkill(personaPath, ref);
    expect(r.ok).toBe(true);
    expect(r.message).toContain("research");
    const list = listSkills(personaPath);
    expect(list.map((s) => s.name)).toContain("research");
    // The spec keeps its body and now declares the skill.
    expect(readFileSync(personaPath, "utf-8")).toContain("sources/research");
  });

  it("refuses a duplicate and a path that does not exist", () => {
    const ref = makeSource("research");
    addSkill(personaPath, ref);
    expect(addSkill(personaPath, ref).ok).toBe(false);
    expect(addSkill(personaPath, "./sources/nope").ok).toBe(false);
    expect(addSkill(personaPath, "   ").ok).toBe(false);
  });

  it("materializes a local skill into skills/<name>/", () => {
    addSkill(personaPath, makeSource("research"));
    const r = pullSkill(personaPath, "research");
    expect(r.ok).toBe(true);
    expect(existsSync(join(baseDir, "skills", "research", "SKILL.md"))).toBe(true);
  });

  it("updates a materialized skill from its source and reports whether it changed", () => {
    const ref = makeSource("research");
    addSkill(personaPath, ref);
    pullSkill(personaPath, "research");
    expect(updateSkill(personaPath, "research").message).toContain("up to date");
    // A new file at the source is picked up on the next update.
    writeFileSync(join(baseDir, "sources", "research", "EXTRA.md"), "more\n", "utf-8");
    const r = updateSkill(personaPath, "research");
    expect(r.ok).toBe(true);
    expect(r.message).toContain("updated");
    expect(existsSync(join(baseDir, "skills", "research", "EXTRA.md"))).toBe(true);
  });

  it("removes a declaration but keeps the files on disk", () => {
    addSkill(personaPath, makeSource("research"));
    pullSkill(personaPath, "research");
    const r = removeSkill(personaPath, "research");
    expect(r.ok).toBe(true);
    expect(listSkills(personaPath)).toEqual([]);
    expect(existsSync(join(baseDir, "skills", "research", "SKILL.md"))).toBe(true);
    expect(removeSkill(personaPath, "research").ok).toBe(false); // already gone
  });

  it("says what to do for a github ref instead of pretending", () => {
    addSkill(personaPath, "github:acme/skills/research");
    const r = pullSkill(personaPath, "research");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("personaxis skills pull research");
  });
});
