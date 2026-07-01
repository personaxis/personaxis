import { describe, it, expect } from "vitest";
import { listCommands, notePostureChange } from "../src/repl/index.js";

describe("REPL slash-command registry", () => {
  const cmds = listCommands();
  const names = cmds.map((c) => c.name);

  it("exposes the core commands (incl. evolution review + session controls)", () => {
    for (const n of ["help", "persona", "state", "review", "audit", "memory", "mode", "improve", "sessions", "resume", "goal", "loop", "exit"]) {
      expect(names).toContain(n);
    }
  });

  it("no longer exposes the pruned redundant commands (/do, /evolve, /sigil)", () => {
    for (const n of ["do", "evolve", "sigil"]) {
      expect(names).not.toContain(n);
    }
  });

  it("has no duplicate names and every command has a description", () => {
    expect(new Set(names).size).toBe(names.length);
    for (const c of cmds) expect(c.desc.length).toBeGreaterThan(0);
  });

  it("hides the 'quit' alias from the menu", () => {
    expect(names).not.toContain("quit");
  });
});

describe("sandbox posture change salience", () => {
  it("stages a one-shot env note naming the new posture, so the next turn re-evaluates", () => {
    const ctx: { postureIndex: number; pendingEnvNote?: string } = { postureIndex: 1 }; // workspace-write
    notePostureChange(ctx);
    expect(ctx.pendingEnvNote).toBeTruthy();
    expect(ctx.pendingEnvNote).toContain("workspace-write");
    expect(ctx.pendingEnvNote?.toLowerCase()).toContain("re-evaluate");
  });

  it("describes read-only vs full-access permissions distinctly", () => {
    const ro: { postureIndex: number; pendingEnvNote?: string } = { postureIndex: 0 };
    notePostureChange(ro);
    expect(ro.pendingEnvNote).toContain("read-only");
    expect(ro.pendingEnvNote?.toLowerCase()).toContain("not write");

    const full: { postureIndex: number; pendingEnvNote?: string } = { postureIndex: 2 };
    notePostureChange(full);
    expect(full.pendingEnvNote).toContain("danger-full-access");
    expect(full.pendingEnvNote?.toLowerCase()).toContain("full access");
  });
});
