/**
 * J.6: structured task state lives outside the transcript, so a long run's goal + plan
 * survive compaction. It is bounded (can never grow the context it protects) and renders
 * only the sections that have content.
 */
import { describe, it, expect } from "vitest";
import { TaskStateTracker } from "../src/task-state.js";

describe("TaskStateTracker", () => {
  it("renders nothing when empty", () => {
    expect(new TaskStateTracker().hasContent).toBe(false);
    expect(new TaskStateTracker().render()).toBe("");
  });

  it("pins goal and plan for compaction survival", () => {
    const t = new TaskStateTracker({ goal: "ship the release" });
    t.setPlan(["build", "test", "tag", "publish"]);
    const block = t.render();
    expect(block).toContain("survives compaction");
    expect(block).toContain("Goal: ship the release");
    expect(block).toContain("1. build");
    expect(block).toContain("4. publish");
  });

  it("dedupes files, keeping the most recent occurrence", () => {
    const t = new TaskStateTracker();
    t.noteFile("a.ts").noteFile("b.ts").noteFile("a.ts");
    expect(t.snapshot().filesTouched).toEqual(["b.ts", "a.ts"]);
  });

  it("upserts sub-tasks by id and marks status", () => {
    const t = new TaskStateTracker();
    t.upsertSubTask("s1", "write module", "active");
    t.upsertSubTask("s1", "write module", "done");
    t.upsertSubTask("s2", "write test", "pending");
    const subs = t.snapshot().subTasks;
    expect(subs).toHaveLength(2);
    expect(subs.find((s) => s.id === "s1")?.status).toBe("done");
    expect(t.render()).toContain("[x] write module");
    expect(t.render()).toContain("[ ] write test");
  });

  it("bounds every list so state cannot itself bloat the context", () => {
    const t = new TaskStateTracker({ limits: { maxDecisions: 3, maxErrors: 2, maxFiles: 2 } });
    for (let i = 0; i < 10; i++) t.recordDecision(`d${i}`).noteError(`e${i}`).noteFile(`f${i}.ts`);
    const s = t.snapshot();
    expect(s.decisions).toEqual(["d7", "d8", "d9"]);
    expect(s.recentErrors).toEqual(["e8", "e9"]);
    expect(s.filesTouched).toEqual(["f8.ts", "f9.ts"]);
  });

  it("replacing the plan keeps only the current one (the planner re-plans)", () => {
    const t = new TaskStateTracker();
    t.setPlan(["old-a", "old-b"]).setPlan(["new-a"]);
    expect(t.snapshot().plan).toEqual(["new-a"]);
  });
});
