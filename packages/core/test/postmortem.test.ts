/**
 * J.3: the post-mortem reflects on a finished run and, only when it was hard-won,
 * abstracts the winning method into a governed skill. Both seams are pure/injected:
 * the trigger heuristic needs no LLM, and extract + write are supplied by the caller.
 */
import { describe, it, expect, vi } from "vitest";
import {
  shouldRunPostmortem,
  runPostmortem,
  type Lesson,
  type PostmortemInput,
} from "../src/postmortem.js";
import type { SkillDraft, WriteResult } from "../src/skill-writer.js";

const lesson: Lesson = {
  name: "bisect-a-failing-build",
  description: "Narrow a failing build to the offending commit",
  capabilities: ["build", "bisect"],
  allowedTools: ["run_command"],
  body: "git bisect start; mark good/bad; confirm.",
};

const input: PostmortemInput = {
  task: "figure out why the build broke",
  transcript: "user: build broke\nassistant: ...\n(4 steps)",
  outcome: "success",
  toolsUsed: ["run_command", "read_file"],
};

describe("shouldRunPostmortem", () => {
  it("skips a trivial one-shot success", () => {
    expect(shouldRunPostmortem({ outcome: "success", steps: 1 })).toBe(false);
  });
  it("skips any non-success (a failure has no method to promote)", () => {
    expect(shouldRunPostmortem({ outcome: "error", steps: 8 })).toBe(false);
    expect(shouldRunPostmortem({ outcome: "stopped", steps: 8 })).toBe(false);
  });
  it("runs on a multi-step success", () => {
    expect(shouldRunPostmortem({ outcome: "success", steps: 4 })).toBe(true);
  });
  it("runs on a success recovered from repeated failures", () => {
    expect(shouldRunPostmortem({ outcome: "success", steps: 2, failuresBeforeSuccess: 2 })).toBe(true);
  });
  it("runs on a low-confidence start that still succeeded", () => {
    expect(shouldRunPostmortem({ outcome: "success", steps: 2, initialConfidence: 0.3 })).toBe(true);
  });
});

describe("runPostmortem", () => {
  it("does not call the LLM when the heuristic is not met", async () => {
    const extract = vi.fn();
    const write = vi.fn();
    const res = await runPostmortem(
      { outcome: "success", steps: 1 },
      input,
      { personaPath: "/p/personaxis.md", mode: "autonomous" },
      { extract, write },
    );
    expect(res.ran).toBe(false);
    expect(extract).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("extracts and writes when the run was hard-won", async () => {
    const written: WriteResult = { outcome: "written", reason: "autonomous", name: lesson.name, hash: "h" };
    const extract = vi.fn(async () => lesson);
    const write = vi.fn(() => written);
    const res = await runPostmortem(
      { outcome: "success", steps: 5 },
      input,
      { personaPath: "/p/personaxis.md", mode: "autonomous" },
      { extract, write },
    );
    expect(extract).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledOnce();
    expect(res.write).toBe(written);
    expect(res.reason).toContain("written");
  });

  it("stops after extract when there is no reusable lesson", async () => {
    const write = vi.fn();
    const res = await runPostmortem(
      { outcome: "success", steps: 5 },
      input,
      { personaPath: "/p/personaxis.md", mode: "autonomous" },
      { extract: async () => null, write },
    );
    expect(res.ran).toBe(true);
    expect(res.reason).toContain("no reusable lesson");
    expect(write).not.toHaveBeenCalled();
  });

  it("falls back to the tools the run used when the lesson names none", async () => {
    let seen: SkillDraft | undefined;
    const write = vi.fn((d: SkillDraft) => {
      seen = d;
      return { outcome: "written", reason: "", name: d.name, hash: "h" } as WriteResult;
    });
    await runPostmortem(
      { outcome: "success", steps: 5 },
      input,
      { personaPath: "/p/personaxis.md", mode: "autonomous" },
      { extract: async () => ({ ...lesson, allowedTools: [] }), write },
    );
    expect(seen?.allowedTools).toEqual(input.toolsUsed);
    expect(seen?.source).toContain("post-mortem");
  });
});
