/**
 * D6: the producers announce themselves.
 *
 * Before this, only the REPL did, so `serve`, `watch`, `compile` and a governed tick held a
 * persona while every fleet view reported "idle". These tests are about the two ways that
 * gets it wrong again: a holder that never disappears (a marker outliving its process is a
 * phantom collision nobody can clear) and a holder that disappears too early (which is the
 * silence that started all this).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { livePresence } from "@personaxis/core";
import { holdPresence } from "../src/presence-session.js";

let dir: string;
let personaPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pxs-hold-"));
  mkdirSync(join(dir, ".personaxis"), { recursive: true });
  personaPath = join(dir, ".personaxis", "personaxis.md");
  writeFileSync(personaPath, "---\nspec_version: 1.1.0\n---\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const activity = (): string | undefined => livePresence(personaPath)[0]?.activity;

describe("holding a persona for the length of a command", () => {
  it("announces the surface and what it is doing", () => {
    const hold = holdPresence(personaPath, { host: "serve", activity: "serving http on 127.0.0.1:7637" });
    const live = livePresence(personaPath);

    expect(live).toHaveLength(1);
    expect(live[0].host).toBe("serve");
    expect(live[0].activity).toBe("serving http on 127.0.0.1:7637");
    hold.release();
  });

  it("disappears on release", () => {
    holdPresence(personaPath, { host: "serve", activity: "serving http" }).release();
    expect(livePresence(personaPath)).toHaveLength(0);
  });

  it("survives a second release", () => {
    // The exit hook and an explicit release both fire on a normal command. If the second
    // one threw, a command that did its job would end by reporting a failure.
    const hold = holdPresence(personaPath, { host: "compile", activity: "compiling" });
    hold.release();
    expect(() => hold.release()).not.toThrow();
  });

  it("does nothing when there is no persona to hold", () => {
    // `observe` fires from a global hook in projects that have no persona at all.
    const hold = holdPresence(undefined, { host: "loop", activity: "running a governed tick" });
    expect(() => {
      hold.note("something");
      hold.release();
    }).not.toThrow();
  });

  it("publishes a new activity at once", () => {
    const hold = holdPresence(personaPath, { host: "loop", activity: "running a governed tick" });
    hold.note("writing memory");
    expect(activity()).toBe("writing memory");
    hold.release();
  });
});

describe("one process is one holder", () => {
  it("nests instead of announcing twice", () => {
    // The real case is `watch` calling `compile`. Presence is keyed by device and pid, so a
    // second announcement would overwrite the first rather than add to it: two holders in
    // one process is a state the file layout cannot represent, and pretending otherwise
    // would leave whichever finished last describing the whole process.
    const outer = holdPresence(personaPath, { host: "compile", activity: "watching for spec edits" });
    const inner = holdPresence(personaPath, { host: "compile", activity: "compiling PERSONA.md" });

    expect(livePresence(personaPath)).toHaveLength(1);
    expect(activity()).toBe("compiling PERSONA.md");

    inner.release();
    // Back to what it interrupted, not gone: `watch` is still watching.
    expect(activity()).toBe("watching for spec edits");
    expect(livePresence(personaPath)).toHaveLength(1);

    outer.release();
    expect(livePresence(personaPath)).toHaveLength(0);
  });

  it("resolves the same persona reached by different paths to one holder", () => {
    const viaRelative = join(dir, ".personaxis", "..", ".personaxis", "personaxis.md");
    const outer = holdPresence(personaPath, { host: "compile", activity: "watching for spec edits" });
    const inner = holdPresence(viaRelative, { host: "compile", activity: "compiling PERSONA.md" });

    expect(activity()).toBe("compiling PERSONA.md");
    inner.release();
    expect(activity()).toBe("watching for spec edits");
    outer.release();
  });

  it("does not add exit hooks per nested hold", () => {
    // `watch` recompiles on every spec edit. A set of listeners per recompile is a leak
    // Node starts warning about after ten, and the warning lands in the user's terminal.
    const outer = holdPresence(personaPath, { host: "compile", activity: "watching for spec edits" });
    const before = process.listenerCount("exit");

    for (let i = 0; i < 12; i++) {
      holdPresence(personaPath, { host: "compile", activity: `compile ${i}` }).release();
    }

    expect(process.listenerCount("exit")).toBe(before);
    outer.release();
  });

  it("keeps the outer hold when an inner one is released out of order", () => {
    const outer = holdPresence(personaPath, { host: "compile", activity: "watching" });
    const first = holdPresence(personaPath, { host: "compile", activity: "compiling" });
    const second = holdPresence(personaPath, { host: "compile", activity: "placing skills" });

    // Releasing the middle one first must not take the outer holder's line with it.
    first.release();
    expect(livePresence(personaPath)).toHaveLength(1);
    second.release();
    expect(livePresence(personaPath)).toHaveLength(1);

    outer.release();
    expect(livePresence(personaPath)).toHaveLength(0);
  });
});
