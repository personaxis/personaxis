/**
 * V6.2: the "press Enter twice to enter a menu" bug.
 *
 * Root cause: suspensions spawned a SECOND full CLI on the same console while
 * this process's stdin stayed in flowing mode with zero listeners, so parent
 * and child split the keystrokes (on Windows the console distributes input
 * among active readers). `withConsoleYielded` pauses our stdin for the child's
 * lifetime and restores the prior mode after; /menu, /model and /config model
 * additionally run the Command Center IN-PROCESS now, so no child exists.
 */
import { describe, it, expect, afterAll } from "vitest";
import { withConsoleYielded } from "../src/repl/daemons.js";

const initiallyPaused = process.stdin.isPaused();
afterAll(() => {
  if (initiallyPaused) process.stdin.pause();
  else process.stdin.resume();
});

describe("withConsoleYielded (V6.2)", () => {
  it("pauses stdin while the guarded flow runs and restores flowing after", async () => {
    process.stdin.resume(); // the REPL state at suspend time: flowing, no listeners
    let pausedInside = false;
    await withConsoleYielded(async () => {
      pausedInside = process.stdin.isPaused();
    });
    expect(pausedInside).toBe(true);
    expect(process.stdin.isPaused()).toBe(false);
  });

  it("keeps stdin paused after, when it was already paused before", async () => {
    process.stdin.pause();
    await withConsoleYielded(async () => {});
    expect(process.stdin.isPaused()).toBe(true);
  });

  it("restores flowing mode even when the flow throws", async () => {
    process.stdin.resume();
    await expect(
      withConsoleYielded(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(process.stdin.isPaused()).toBe(false);
  });
});
