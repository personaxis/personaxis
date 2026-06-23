import { describe, it, expect } from "vitest";
import { listCommands } from "../src/repl/index.js";

describe("REPL slash-command registry", () => {
  const cmds = listCommands();
  const names = cmds.map((c) => c.name);

  it("exposes the core commands including the new agent + mode controls", () => {
    for (const n of ["help", "persona", "state", "evolve", "do", "audit", "memory", "mode", "goal", "loop", "exit"]) {
      expect(names).toContain(n);
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
