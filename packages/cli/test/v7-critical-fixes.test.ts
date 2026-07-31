/**
 * Critical fixes found by dogfooding the app end to end.
 *
 * A1 the persona thanked him "for restoring my access" out of nowhere: the posture
 *    note was glued in front of the USER's text, so the model answered it as if the user
 *    had written it. It must travel as its own system message.
 * A2 shift+tab did nothing until the next turn: the posture was snapshotted when the
 *    agent was built. The policy now reads it live.
 * A7 the model could not answer "what is your goal": `/goal set X` stored the literal
 *    text "set X", and the goal sat buried mid-prompt.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { makeCtx } from "../src/repl/session.js";
import { makeMeter, buildPolicy, POSTURES, notePostureChange, readGoalText, goalPathFor, writeGoalAt } from "../src/repl/config.js";
import { buildAwarenessBlock } from "../src/repl/awareness.js";
import { runCommand } from "../src/repl/commands.js";
import { writeStarterPersona } from "../src/starter.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pxs-v7a-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const scaffold = () => makeCtx(writeStarterPersona(dir, "Vega"), makeMeter());

describe("V7.A1: the environment note is system speech, not the user's", () => {
  it("notePostureChange stores the note on ctx, never merged into the user line", () => {
    const ctx = scaffold();
    ctx.postureIndex = POSTURES.indexOf("danger-full-access");
    notePostureChange(ctx);
    expect(ctx.pendingEnvNote).toContain("danger-full-access");
    // The contract the agent relies on: the note is a standalone string that the caller
    // passes as `envNote`, so a user turn is never rewritten.
    expect(ctx.pendingEnvNote?.startsWith("[environment change]")).toBe(true);
  });
});

describe("V7.A2: the sandbox posture is live, not snapshotted", () => {
  it("policy.sandbox follows ctx.postureIndex after the policy was built", () => {
    const ctx = scaffold();
    ctx.postureIndex = 0;
    const policy = buildPolicy(ctx);
    expect(policy.sandbox).toBe(POSTURES[0]);
    // shift+tab mid-turn: the SAME policy object must now report the new posture.
    ctx.postureIndex = 2;
    expect(policy.sandbox).toBe(POSTURES[2]);
  });
});

describe("V7.A7: /goal verbs and placement", () => {
  /**
   * V8.A retired the `/goal` slash command: the capability moved into
   * Persona → Evolution and the `personaxis goal` subcommand. These now test the
   * shared implementation both of those call, which is where the bug lived.
   */
  it("storing a goal keeps the text verbatim, never the verb", () => {
    const ctx = scaffold();
    const goalPath = goalPathFor(ctx.handle.personaPath);
    writeGoalAt(goalPath, "keep every reply formal this week");
    expect(existsSync(goalPath)).toBe(true);
    const stored = JSON.parse(readFileSync(goalPath, "utf-8")) as { text: string };
    expect(stored.text).toBe("keep every reply formal this week");
    expect(stored.text.startsWith("set ")).toBe(false); // the reported bug
  });

  it("empty text clears it: 'no objective' is a state, not an error", () => {
    const ctx = scaffold();
    const goalPath = goalPathFor(ctx.handle.personaPath);
    writeGoalAt(goalPath, "ship the release");
    expect(readGoalText(ctx.handle)).toBe("ship the release");
    writeGoalAt(goalPath, "   ");
    expect(readGoalText(ctx.handle)).toBeUndefined();
  });

  it("the goal lands in the runtime context, last, with an explicit instruction", () => {
    const ctx = scaffold();
    const block = buildAwarenessBlock(ctx.handle.personaPath, {
      frontmatter: ctx.handle.frontmatter as Record<string, unknown>,
      goal: "keep the tone formal",
      cwd: dir,
    });
    expect(block).toContain("Your standing objective");
    expect(block).toContain("keep the tone formal");
    expect(block).toContain("do not search memory");
    // Recency slot: nothing follows it.
    expect(block.trimEnd().endsWith("do not search memory.")).toBe(true);
  });

  it("no goal means no section at all (zero noise)", () => {
    const ctx = scaffold();
    const block = buildAwarenessBlock(ctx.handle.personaPath, {
      frontmatter: ctx.handle.frontmatter as Record<string, unknown>,
      cwd: dir,
    });
    expect(block).not.toContain("standing objective");
  });
});
