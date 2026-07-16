/**
 * V2-F1 phase gate: cross-session name recall, end to end, OFFLINE.
 *
 * Session A tells the persona "me llamo David" and exits. Session B is a brand-new
 * process; the persona must know the name WITHOUT being asked to search: the
 * profile (user.* preferences) loads first in every recall path, and even the
 * offline reflective responder addresses a known user by name.
 *
 * USERPROFILE/HOME point at the sandbox so the walk-up (which stops at the home
 * dir) never inherits the developer's real ~/.personaxis.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(__dirname, "..", "dist", "index.js");
const built = existsSync(CLI);

let cwd: string;
beforeAll(() => {
  cwd = mkdtempSync(join(tmpdir(), "pxs-recall-"));
});
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

function repl(input: string): string {
  return execFileSync("node", [CLI], {
    cwd,
    input,
    encoding: "utf-8",
    env: {
      ...process.env,
      FORCE_COLOR: "0",
      PERSONAXIS_NO_ANIM: "1",
      PERSONAXIS_HOME: join(cwd, ".pxs-home"),
      PERSONAXIS_NO_INHERIT: "1", // never inherit the developer's real ~/.personaxis
      USERPROFILE: cwd, // windows homedir()
      HOME: cwd, // unix homedir()
    },
  });
}

describe.runIf(built)("cross-session name recall (V2-F1 gate)", () => {
  it("session A learns the name; session B (new process) greets by name", { timeout: 120_000 }, () => {
    const a = repl("hola, me llamo David\n");
    expect(a).toContain("is awake");
    // The fact persisted as a subject-qualified fact (entity-neutral, not "user")...
    const prefs = join(cwd, ".personaxis", "memory", "preferences.json");
    expect(existsSync(prefs)).toBe(true);
    expect(JSON.parse(readFileSync(prefs, "utf-8"))["interlocutor.name"].value).toBe("David");
    // ...and learning it was an autobiographical milestone.
    const auto = readFileSync(join(cwd, ".personaxis", "memory", "autobiographical.jsonl"), "utf-8");
    expect(auto).toMatch(/learned interlocutor\.name = David/);

    const b = repl("hola de nuevo, sabes quien soy?\n");
    expect(b).toContain("David"); // recalled in a NEW process, no search requested
  });
});
