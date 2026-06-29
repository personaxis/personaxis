import { describe, it, expect } from "vitest";
import { listCommands } from "../src/repl/index.js";

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
