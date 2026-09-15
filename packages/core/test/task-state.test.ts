/**
 * J.6: structured task state lives outside the transcript, so a long run's goal + plan
 * survive compaction. It is bounded (can never grow the context it protects) and renders
 * only the sections that have content.
 */
import { describe, it, expect } from "vitest";
import { TaskStateTracker } from "../src/task-state.js";
import { applyTaskUpdate } from "../src/tools/update-tasks.js";

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

describe("the persona's own task list (E81)", () => {
  it("marks a step done, and verified, only when a call succeeded after the step last changed", () => {
    const t = new TaskStateTracker();
    t.replaceTasks([{ text: "write the design", status: "active" }, { text: "build the prototype", status: "pending" }], []);
    const unbacked = t.replaceTasks([{ text: "write the design", status: "done" }, { text: "build the prototype", status: "pending" }], ["c1"]);

    expect(unbacked).toEqual([]);
    expect(t.snapshot().subTasks[0]).toMatchObject({ text: "write the design", status: "done", verified: true, evidence: ["c1"] });
  });

  it("keeps a done with nothing done behind it as said done, and says so in words", () => {
    const t = new TaskStateTracker();
    t.replaceTasks([{ text: "write the design", status: "active" }], ["c1"]);
    const unbacked = t.replaceTasks([{ text: "write the design", status: "done" }], ["c1"]);

    expect(unbacked.map((task) => task.text)).toEqual(["write the design"]);
    expect(t.renderTaskList()).toContain("[?] write the design (said done; nothing done backs it yet)");
  });

  it("checks a said-done step again when it is sent after the work", () => {
    const t = new TaskStateTracker();
    t.replaceTasks([{ text: "write the pitch", status: "done" }], []);
    expect(t.snapshot().subTasks[0]!.verified).toBe(false);

    t.replaceTasks([{ text: "write the pitch", status: "done" }], ["c7"]);
    expect(t.snapshot().subTasks[0]).toMatchObject({ verified: true, evidence: ["c7"] });
  });

  it("lets a step written for the first time as done be backed by any call in the run", () => {
    // A persona that does the work first and writes the list afterwards is not lying.
    const t = new TaskStateTracker();
    t.replaceTasks([{ text: "read the reference", status: "done" }], ["c1", "c2"]);

    expect(t.snapshot().subTasks[0]).toMatchObject({ verified: true, evidence: ["c2"] });
  });

  it("lets one call back one step: two steps marked done after a single call leave the second said done", () => {
    const t = new TaskStateTracker();
    t.replaceTasks([{ text: "design", status: "active" }, { text: "pitch", status: "pending" }], []);
    const unbacked = t.replaceTasks([{ text: "design", status: "done" }, { text: "pitch", status: "done" }], ["c2"]);

    expect(t.snapshot().subTasks.map((task) => [task.text, task.verified])).toEqual([["design", true], ["pitch", false]]);
    expect(unbacked.map((task) => task.text)).toEqual(["pitch"]);
  });

  it("gives a call back when its step is taken back from done", () => {
    // Written first with `pitch` created after `c1`, and it failed, rightly: a call made before a step
    // existed cannot back it, given back or not. The expectation was wrong, not the rule. Here `pitch`
    // exists when `c1` happens, `design` takes it, and gives it back.
    const t = new TaskStateTracker();
    t.replaceTasks([{ text: "design", status: "active" }, { text: "pitch", status: "pending" }], []);
    t.replaceTasks([{ text: "design", status: "done" }, { text: "pitch", status: "pending" }], ["c1"]);
    expect(t.snapshot().subTasks[0]).toMatchObject({ verified: true, evidence: ["c1"] });

    t.replaceTasks([{ text: "design", status: "active" }, { text: "pitch", status: "done" }], ["c1"]);
    expect(t.snapshot().subTasks[1]).toMatchObject({ text: "pitch", verified: true, evidence: ["c1"] });
  });

  it("replaces the list whole: a step left out is gone, and resending a step by its text updates it", () => {
    const t = new TaskStateTracker();
    t.replaceTasks([{ text: "Design", status: "pending" }, { text: "Pitch", status: "pending" }], []);
    t.replaceTasks([{ text: "design", status: "active" }], []);

    expect(t.snapshot().subTasks.map((task) => [task.text, task.status])).toEqual([["design", "active"]]);
  });

  it("tells the model what it got wrong instead of dropping the call", () => {
    const t = new TaskStateTracker();
    expect(applyTaskUpdate(t, { tasks: "a list" }, []).ok).toBe(false);

    const partial = applyTaskUpdate(
      t,
      { tasks: [{ text: "design", status: "in_progress" }, { text: "", status: "done" }, { text: "pitch", status: "finished" }] },
      [],
    );
    expect(partial.ok).toBe(true);
    expect(partial.reply).toContain("[~] design");
    expect(partial.reply).toContain("Left out task 2, 3");
  });

  it("says which steps were marked done with nothing behind them", () => {
    const t = new TaskStateTracker();
    const reply = applyTaskUpdate(t, { tasks: [{ text: "pitch", status: "done" }] }, []).reply;

    expect(reply).toContain("Marked done with nothing you did backing it: pitch.");
  });
});
