import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  registerPersona,
  registerProject,
  createCollection,
  addToCollection,
  createTeam,
  addTeamMember,
  setTeamGoal,
  getTeam,
  resolveEffectivePersona,
  overseerView,
  machineId,
  loadRegistry,
} from "../src/index.js";

/**
 * A LIVE project must actually hold a persona: since V8.E5 a folder that exists but has no
 * `.personaxis/` is pruned like any other phantom, because deleting a persona used to leave a
 * permanent entry in the fleet. `process.cwd()` under vitest is `packages/core`, which has
 * none, so these tests point at the repository root, which does.
 */
const LIVE_PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

let home: string;
let prev: string | undefined;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pxs-home-"));
  prev = process.env.PERSONAXIS_HOME;
  process.env.PERSONAXIS_HOME = home;
});
afterEach(() => {
  if (prev === undefined) delete process.env.PERSONAXIS_HOME;
  else process.env.PERSONAXIS_HOME = prev;
  rmSync(home, { recursive: true, force: true });
});

describe("overseer registry", () => {
  it("registers personas, projects, collections and summarizes", () => {
    registerPersona("cmo");
    registerPersona("frontend-expert");
    // V7.A8: only REAL, non-ephemeral directories register (a dead path is not a project).
    const realProject = LIVE_PROJECT;
    registerProject(realProject, ["cmo"]);
    createCollection("growth-team");
    addToCollection("growth-team", "persona", "cmo");
    addToCollection("growth-team", "project", realProject);

    const v = overseerView();
    expect(v.personas).toBe(2);
    expect(v.projects).toBe(1);
    expect(v.collections).toBe(1);
    expect(v.detail.collections["growth-team"].personas).toContain("cmo");
    expect(v.machines).toBeGreaterThanOrEqual(1);
  });

  it("machineId is stable across calls", () => {
    expect(machineId()).toBe(machineId());
  });

  it("teams are operational (roles + lead + goal), distinct from collections", () => {
    createTeam("launch-squad", "cmo");
    addTeamMember("launch-squad", "frontend", "builder");
    addTeamMember("launch-squad", "security", "reviewer");
    setTeamGoal("launch-squad", "ship the v1 launch safely");
    const t = getTeam("launch-squad")!;
    expect(t.lead).toBe("cmo");
    expect(t.goal).toBe("ship the v1 launch safely");
    expect(t.members.find((m) => m.slug === "frontend")!.role).toBe("builder");
    // a collection is just grouping, not a team
    createCollection("marketing-stuff");
    addToCollection("marketing-stuff", "persona", "cmo");
    const v = overseerView();
    expect(v.teams).toBe(1);
    expect(v.collections).toBe(1);
  });

  it("project overlay takes precedence over global", () => {
    const proj = mkdtempSync(join(tmpdir(), "pxs-proj-"));
    const overlay = join(proj, ".personaxis", "personas", "cmo");
    mkdirSync(overlay, { recursive: true });
    writeFileSync(join(overlay, "personaxis.md"), "---\n---\n");
    const r = resolveEffectivePersona(proj, "cmo");
    expect(r.scope).toBe("project-overlay");
    rmSync(proj, { recursive: true, force: true });
  });

  it("falls back to global path when no overlay exists", () => {
    const r = resolveEffectivePersona("/nonexistent", "cmo");
    expect(r.scope).toBe("none");
    expect(r.path).toContain("cmo");
    // registry persists machine touch
    expect(loadRegistry().version).toBe(1);
  });
});
