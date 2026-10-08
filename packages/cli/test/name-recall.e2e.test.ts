/**
 * V2-F1 phase gate: cross-session name recall, end to end.
 *
 * Session A tells the persona "me llamo Mara" and exits. Session B is a brand-new
 * process; the persona must know the name WITHOUT being asked to search: the
 * profile (subject-qualified preferences) loads first in every recall path. The
 * model is a local stand-in that proposes the fact when it appraises and uses a
 * known name when it answers; persisting the fact and putting it in the next
 * session's prompt is the real runtime.
 *
 * USERPROFILE/HOME point at the sandbox so the walk-up (which stops at the home
 * dir) never inherits the developer's real ~/.personaxis.
 */
import { writeTestPersona } from "./helpers/test-persona.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { modelEnv, runCli, startFakeModel, type FakeModel } from "./helpers/fake-model.js";

const CLI = join(__dirname, "..", "dist", "index.js");
const built = existsSync(CLI);

let cwd: string;
let model: FakeModel;
beforeAll(async () => {
  cwd = mkdtempSync(join(tmpdir(), "pxs-recall-"));
  // The product writes no starter persona any more (2026-10-08): the session gets the test one.
  writeTestPersona(cwd, "Aria");
  model = await startFakeModel();
});
afterAll(async () => {
  await model.close();
  rmSync(cwd, { recursive: true, force: true });
});

async function repl(input: string): Promise<string> {
  const r = await runCli(CLI, [], {
    cwd,
    input,
    env: {
      ...modelEnv(model),
      PERSONAXIS_NO_ANIM: "1",
      PERSONAXIS_HOME: join(cwd, ".pxs-home"),
      PERSONAXIS_NO_INHERIT: "1", // never inherit the developer's real ~/.personaxis
      USERPROFILE: cwd, // windows homedir()
      HOME: cwd, // unix homedir()
    },
  });
  return r.out;
}

describe.runIf(built)("cross-session name recall (V2-F1 gate)", () => {
  it("session A learns the name; session B (new process) greets by name", { timeout: 120_000 }, async () => {
    const a = await repl("hola, me llamo Mara\n");
    expect(a).toContain("is awake");
    // The fact persisted as a subject-qualified fact (entity-neutral, not "user")...
    const prefs = join(cwd, ".personaxis", "memory", "preferences.json");
    expect(existsSync(prefs)).toBe(true);
    expect(JSON.parse(readFileSync(prefs, "utf-8"))["interlocutor.name"].value).toBe("Mara");
    // ...and learning it was an autobiographical milestone.
    const auto = readFileSync(join(cwd, ".personaxis", "memory", "autobiographical.jsonl"), "utf-8");
    expect(auto).toMatch(/learned interlocutor\.name = Mara/);

    const b = await repl("hola de nuevo, sabes quien soy?\n");
    expect(b).toContain("Mara"); // recalled in a NEW process, no search requested
  });
});
