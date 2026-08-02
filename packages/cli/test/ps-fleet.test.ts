/**
 * What the fleet view is allowed to claim (D6).
 *
 * `ps` used to print "awake" from `.live.json`, a marker the loop writes when state DRIFTS.
 * That answered a different question than the one the column asked, and it was wrong in
 * both directions: a `serve` holding a persona for an hour without one observation read as
 * idle, and a persona whose state had just moved read as awake with nothing attached.
 */
import { describe, it, expect } from "vitest";
import type { Presence } from "@personaxis/core";
import { heldBy, presenceDetail } from "../src/commands/ps.js";

const SELF = "this-device";

function instance(over: Partial<Presence> = {}): Presence {
  const now = new Date().toISOString();
  return {
    deviceId: SELF,
    machine: "desktop",
    user: "me",
    pid: 1,
    host: "repl",
    since: now,
    ts: now,
    ...over,
  };
}

describe("who is holding it", () => {
  it("names the surfaces", () => {
    expect(heldBy([instance({ host: "repl" }), instance({ host: "serve", pid: 2 })])).toBe("repl · serve");
  });

  it("does not repeat a surface held twice", () => {
    // Two REPLs is worth knowing; "repl · repl" is not how to say it.
    expect(heldBy([instance({ host: "repl" }), instance({ host: "repl", pid: 2 })])).toBe("repl");
  });

  it("says nothing when nobody is", () => {
    expect(heldBy([])).toBe("");
  });
});

describe("the detail line", () => {
  it("names another machine, because that is the collision the row cannot show", () => {
    const detail = presenceDetail([instance(), instance({ deviceId: "laptop", machine: "MacBook", pid: 2 })], SELF);
    expect(detail).toContain("MacBook");
  });

  it("says what the holders are doing", () => {
    const detail = presenceDetail([instance({ activity: "answering" })], SELF);
    expect(detail).toBe("answering");
  });

  it("stays quiet for a lone idle holder on this machine", () => {
    // A line that only ever repeats what the row already said is noise, and this view is
    // read at a glance.
    expect(presenceDetail([instance({ activity: "idle" })], SELF)).toBe("");
    expect(presenceDetail([instance()], SELF)).toBe("");
  });

  it("combines the machine and the activity when both are worth saying", () => {
    const detail = presenceDetail(
      [instance({ deviceId: "laptop", machine: "MacBook", host: "claude-code", activity: "answering" })],
      SELF,
    );
    expect(detail).toContain("MacBook");
    expect(detail).toContain("answering");
  });
});
