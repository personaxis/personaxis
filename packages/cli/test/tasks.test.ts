import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTask, listTasks, readTaskOutput, tasksDir } from "../src/repl/tasks.js";

describe("background tasks registry (V2-F3.B10)", () => {
  let personaPath: string;
  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "pxs-tasks-"));
    personaPath = join(dir, "personaxis.md");
  });

  it("writes and lists a task; a running record with a dead pid becomes done", () => {
    mkdirSync(tasksDir(personaPath), { recursive: true });
    const outFile = join(tasksDir(personaPath), "t1.out");
    writeFileSync(outFile, "hello output");
    writeTask(personaPath, {
      id: "t1",
      prompt: "do x",
      status: "running",
      pid: 2147480000, // not a live process
      started: new Date().toISOString(),
      outFile,
    });
    const list = listTasks(personaPath);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("t1");
    expect(list[0].status).toBe("done");
    expect(readTaskOutput(personaPath, "t1")).toContain("hello output");
  });

  it("returns null output for an unknown task", () => {
    expect(readTaskOutput(personaPath, "nope")).toBeNull();
  });
});
