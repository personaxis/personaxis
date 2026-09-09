/**
 * J.1b: the tool catalog is now the union of the `builtin/` modules, and must be identical
 * to the hand-written array it replaced (same names, same order) plus a category per tool.
 * Behavioral identity is covered by the existing agent/tool tests still passing; this test
 * pins the catalog's shape so a migration slip is caught here rather than in the loop.
 */
import { describe, it, expect } from "vitest";
import { TOOLS, toolByName, validateToolArgs, type ToolCategory } from "../src/tools/registry.js";
import { DEFAULT_POLICY } from "../src/sandbox.js";
import { noExecution } from "../src/ports/execution.js";

/**
 * E32: the third argument is the ExecutionPort, WHERE the action happens, and these
 * calls were leaving it out. One that refuses everything rather than a live one, so
 * the call also asserts what it should: none of these tools touches the machine.
 */
const INERT = noExecution("this tool must not act");

const EXPECTED: Array<{ name: string; category: ToolCategory; isReadOnly: boolean }> = [
  { name: "run_command", category: "shell", isReadOnly: false },
  { name: "read_file", category: "fs", isReadOnly: true },
  { name: "list_dir", category: "fs", isReadOnly: true },
  // C5: a read of many files at once, so it sits with the reads and carries their
  // permission. Added here in the same commit that added the tool, because this list
  // is what stops a catalogue changing shape without anybody deciding.
  { name: "find_in_files", category: "fs", isReadOnly: true },
  { name: "write_file", category: "fs", isReadOnly: false },
  { name: "edit_file", category: "fs", isReadOnly: false },
  { name: "finish", category: "meta", isReadOnly: true },
];

describe("the built-in catalog (J.1b)", () => {
  it("is the same tools in the same order as before the migration", () => {
    expect(TOOLS.map((t) => t.name)).toEqual(EXPECTED.map((e) => e.name));
  });

  it("gives every tool a category (the whole point of the migration)", () => {
    for (const e of EXPECTED) {
      const t = toolByName(e.name);
      expect(t, `${e.name} missing`).toBeDefined();
      expect(t!.category, `${e.name} category`).toBe(e.category);
      expect(t!.isReadOnly, `${e.name} isReadOnly`).toBe(e.isReadOnly);
    }
  });

  it("keeps the schema as the runtime validation source", () => {
    const write = toolByName("write_file")!;
    expect(validateToolArgs(write, { path: "a", content: "b" })).toEqual([]);
    expect(validateToolArgs(write, { path: "a" })).toContain("missing required arg 'content'");
  });

  it("preserves behavior: finish returns its summary, gates still decide", async () => {
    const finish = toolByName("finish")!;
    expect(finish.gate({ summary: "done" }, DEFAULT_POLICY).decision).toBe("allow");
    expect(await finish.execute({ summary: "all done" }, DEFAULT_POLICY, INERT)).toBe("all done");
  });
});
