import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerPersona,
  registerProject,
  createCollection,
  addToCollection,
  resolveEffectivePersona,
  overseerView,
  machineId,
  loadRegistry,
} from "../src/index.js";

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
    registerProject("/proj/a", ["cmo"]);
    createCollection("growth-team");
    addToCollection("growth-team", "persona", "cmo");
    addToCollection("growth-team", "project", "/proj/a");

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
