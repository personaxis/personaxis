/**
 * V3.1 bug 1: a sub-persona's compiled doc references `./memory.md` relative to
 * the persona's OWN folder, but file tools resolved every relative path against
 * `policy.workspaceRoot` (the process CWD), so off-home reads failed with
 * "file not found" and the failed read aborted runs via no_progress.
 *
 * The fix, in three general parts, each covered here:
 *  (1) `personaResourceRoots` derives the active persona's read roots (any level),
 *  (2) read tools fall back through `policy.resourceRoots` (writes do NOT),
 *  (3) a missing file is an observation ("note: …"), never an "error:" that
 *      zeroes step progress.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { DEFAULT_POLICY, personaResourceRoots, type Policy } from "../src/sandbox.js";
import { readFileSafe, listDirSafe, executeFileWrite } from "../src/tools/exec.js";
import { toolByName } from "../src/tools/registry.js";
import { localExecution } from "../src/ports/execution.js";

let work: string;
let personaDir: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "pxs-work-"));
  personaDir = mkdtempSync(join(tmpdir(), "pxs-persona-"));
  writeFileSync(join(personaDir, "memory.md"), "# Semantic memory\nknows the user", "utf-8");
  mkdirSync(join(personaDir, "memory"), { recursive: true });
  writeFileSync(join(personaDir, "memory", "2026-07-17.md"), "episodic", "utf-8");
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
  rmSync(personaDir, { recursive: true, force: true });
});

const policyWith = (roots: string[]): Policy => ({
  ...DEFAULT_POLICY,
  workspaceRoot: work,
  resourceRoots: roots,
});

describe("personaResourceRoots", () => {
  it("derives the persona's own folder plus its project root, for every level", () => {
    const proj = ["C:", "proj"].join(sep);
    const sub = join(proj, ".personaxis", "personas", "cmo", "personaxis.md");
    const root = join(proj, ".personaxis", "personaxis.md");
    expect(personaResourceRoots(sub)).toEqual([
      resolve(join(proj, ".personaxis", "personas", "cmo")),
      resolve(proj),
    ]);
    expect(personaResourceRoots(root)).toEqual([resolve(join(proj, ".personaxis")), resolve(proj)]);
  });
});

describe("read-side resourceRoots fallback", () => {
  it("read_file resolves ./memory.md against the persona's home when absent in the workspace", () => {
    const r = readFileSafe("./memory.md", policyWith([personaDir]));
    expect(r.ok).toBe(true);
    expect(r.content).toContain("knows the user");
  });

  it("the workspace root still wins when the file exists in both", () => {
    writeFileSync(join(work, "memory.md"), "workspace copy", "utf-8");
    const r = readFileSafe("./memory.md", policyWith([personaDir]));
    expect(r.ok).toBe(true);
    expect(r.content).toBe("workspace copy");
  });

  it("list_dir falls back the same way", () => {
    const r = listDirSafe("./memory", policyWith([personaDir]));
    expect(r.ok).toBe(true);
    expect(r.content).toContain("2026-07-17.md");
  });

  it("writes do NOT fall back: a new file lands in the workspace, not the persona home", () => {
    const r = executeFileWrite("./notes.md", "x", policyWith([personaDir]));
    expect(r.ok).toBe(true);
    expect(existsSync(join(work, "notes.md"))).toBe(true);
    expect(existsSync(join(personaDir, "notes.md"))).toBe(false);
    expect(readFileSync(join(work, "notes.md"), "utf-8")).toBe("x");
  });
});

describe("missing file is an answer, not a failure", () => {
  it("read_file returns a note (not error:) for a nonexistent path", async () => {
    const out = await toolByName("read_file")!.execute({ path: "./nope.md" }, policyWith([]), localExecution());
    expect(out).toMatch(/^note: /);
    expect(out).toContain("does not exist");
  });

  it("list_dir returns a note (not error:) for a nonexistent dir", async () => {
    const out = await toolByName("list_dir")!.execute({ path: "./nope" }, policyWith([]), localExecution());
    expect(out).toMatch(/^note: /);
  });

  it("a genuine read failure still reports error:", async () => {
    // Reading a DIRECTORY as a file is a real I/O error (EISDIR), not a missing file.
    mkdirSync(join(work, "adir"), { recursive: true });
    const out = await toolByName("read_file")!.execute({ path: "./adir" }, policyWith([]), localExecution());
    expect(out.startsWith("error:")).toBe(true);
  });
});
