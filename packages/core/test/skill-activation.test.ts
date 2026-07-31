/**
 * J.2: skills narrow the tool catalog to what a task needs. A filesystem task exposes the fs
 * tools + base, not the shell; a task no skill covers keeps the full catalog (never hidden
 * without a reason).
 */
import { describe, it, expect } from "vitest";
import { taskTokens, activeSkillsFor, selectActiveTools, type ActiveSkill } from "../src/skill-activation.js";
import { BUILTIN_TOOLS } from "../src/tools/builtin/index.js";

const skills: ActiveSkill[] = [
  { name: "file-editing", capabilities: ["file", "edit", "read", "write"], allowedTools: ["read_file", "list_dir", "write_file", "edit_file"] },
  { name: "shell-ops", capabilities: ["shell", "command", "build", "test"], allowedTools: ["run_command"] },
];

describe("skill → tool selection (J.2)", () => {
  it("tokenizes a task, dropping stopwords and short words", () => {
    const toks = taskTokens("please read the config file and edit it");
    expect(toks).toContain("read");
    expect(toks).toContain("config");
    expect(toks).toContain("file");
    expect(toks).not.toContain("the");
    expect(toks).not.toContain("it");
  });

  it("activates only the skills whose capabilities the task hits", () => {
    const active = activeSkillsFor("read and edit a file", skills);
    expect(active.map((s) => s.name)).toEqual(["file-editing"]);
  });

  it("subsets the catalog to the active skills' tools + base (finish)", () => {
    const tools = selectActiveTools("read and edit a file", BUILTIN_TOOLS, skills);
    const names = tools.map((t) => t.name).sort();
    // fs tools the skill needs, plus finish (meta), and NOT run_command (shell).
    expect(names).toContain("read_file");
    expect(names).toContain("edit_file");
    expect(names).toContain("finish");
    expect(names).not.toContain("run_command");
  });

  it("exposes the shell tool for a shell task", () => {
    const tools = selectActiveTools("run the build command", BUILTIN_TOOLS, skills);
    expect(tools.map((t) => t.name)).toContain("run_command");
    expect(tools.map((t) => t.name)).toContain("finish");
  });

  it("keeps the FULL catalog when no skill matches the task", () => {
    const tools = selectActiveTools("meditate on the meaning of things", BUILTIN_TOOLS, skills);
    expect(tools.length).toBe(BUILTIN_TOOLS.length);
  });

  it("respects explicit base overrides", () => {
    const tools = selectActiveTools("read a file", BUILTIN_TOOLS, skills, { alwaysNames: ["finish", "list_dir"] });
    // list_dir forced in even though the fs skill already includes it; base is honored.
    expect(tools.map((t) => t.name)).toContain("list_dir");
  });
});
