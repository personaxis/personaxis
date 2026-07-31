/**
 * A real registry had 26 projects, 25 of them throwaway TEST directories under
 * the OS temp dir, all deleted, and "personas 0" while he clearly had personas. Three
 * defects: temp paths were registered, dead paths were never dropped, and the persona
 * count only looked at GLOBAL personas.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {


  registerProject,
  pruneRegistry,
  liveProjects,
  overseerView,
  isEphemeralProjectPath,
  loadRegistry,
  saveRegistry,
  personaxisHome,
} from "../src/registry.js";

/**
 * A LIVE project must actually hold a persona: since V8.E5 a folder that exists but has no
 * `.personaxis/` is pruned like any other phantom, because deleting a persona used to leave a
 * permanent entry in the fleet. `process.cwd()` under vitest is `packages/core`, which has
 * none, so these tests point at the repository root, which does.
 */
const LIVE_PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

beforeEach(() => {
  // PERSONAXIS_HOME is hermetic per worker (setup-home); start each test from empty.
  saveRegistry({ version: 1, personas: {}, projects: {}, collections: {}, teams: {}, machines: {} });
});

describe("registry hygiene (V7.A8)", () => {
  it("refuses to register a path under the OS temp dir", () => {
    const temp = mkdtempSync(join(tmpdir(), "pxs-onboard-"));
    try {
      expect(isEphemeralProjectPath(temp)).toBe(true);
      expect(registerProject(temp, [])).toBeUndefined();
      expect(Object.keys(loadRegistry().projects)).toHaveLength(0);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("refuses a path that does not exist", () => {
    expect(registerProject(join(process.cwd(), "no-such-dir-xyz"), [])).toBeUndefined();
    expect(Object.keys(loadRegistry().projects)).toHaveLength(0);
  });

  it("registers a real directory once, canonically (no duplicates by spelling)", () => {
    const root = LIVE_PROJECT;
    registerProject(root, ["ventas"]);
    registerProject(root + "\\", ["ventas"]);
    registerProject(root + "/", ["ventas"]);
    expect(Object.keys(loadRegistry().projects)).toHaveLength(1);
  });

  it("prunes dead entries and reports what it removed", () => {
    const gone = join(tmpdir(), "pxs-dead-project");
    const reg = loadRegistry();
    // Simulate a polluted registry (written before the guard existed).
    reg.projects[gone] = { root: gone, slugs: [], lastSeen: "2026-01-01T00:00:00Z", machine: "m" };
    reg.projects[LIVE_PROJECT] = { root: LIVE_PROJECT, slugs: [], lastSeen: "2026-07-20T00:00:00Z", machine: "m" };
    saveRegistry(reg);

    const result = pruneRegistry();
    expect(result.removed).toContain(gone);
    expect(result.kept).toBe(1);
    expect(liveProjects().map((p) => p.root)).toEqual([LIVE_PROJECT]);
  });

  it("counts personas ACROSS projects, not just global ones", () => {
    registerProject(LIVE_PROJECT, ["ventas", "legal"]);
    const v = overseerView();
    expect(v.projects).toBe(1);
    expect(v.personas).toBe(0); // no global personas registered
    expect(v.personasInProjects).toBe(3); // main + 2 subs, the number a user expects
  });

  it("overseerView self-heals: a dead entry never reaches the display", () => {
    const reg = loadRegistry();
    reg.projects[join(tmpdir(), "pxs-ghost")] = {
      root: join(tmpdir(), "pxs-ghost"),
      slugs: [],
      lastSeen: "2026-01-01T00:00:00Z",
      machine: "m",
    };
    saveRegistry(reg);
    expect(overseerView().projects).toBe(0);
    expect(existsSync(personaxisHome())).toBe(true);
  });
});
