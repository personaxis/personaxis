/**
 * V2-F3.A/D: session-continuity flags (--continue / --resume) and the /status +
 * /doctor observability commands, end to end against the built binary.
 * PERSONAXIS_HOME + HOME are sandboxed and PERSONAXIS_NO_INHERIT stops the
 * git-like walk-up from attaching to the developer's real persona.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { modelEnv, runCli, startFakeModel, type FakeModel } from "./helpers/fake-model.js";

const CLI = join(__dirname, "..", "dist", "index.js");
const built = existsSync(CLI);

let cwd: string;
let model: FakeModel;
beforeAll(async () => {
  cwd = mkdtempSync(join(tmpdir(), "pxs-flags-"));
  model = await startFakeModel();
});
afterAll(async () => {
  await model.close();
  rmSync(cwd, { recursive: true, force: true });
});

/** The REPL in a new process. With a model unless the test is about having none. */
async function repl(input: string, args: string[] = [], withModel = true): Promise<string> {
  const r = await runCli(CLI, args, {
    cwd,
    input,
    env: {
      ...(withModel ? modelEnv(model) : { PERSONAXIS_ENDPOINT: "", PERSONAXIS_MODEL: "", PERSONAXIS_API_KEY: "" }),
      PERSONAXIS_NO_ANIM: "1",
      PERSONAXIS_HOME: join(cwd, ".pxs-home"),
      PERSONAXIS_NO_INHERIT: "1",
      USERPROFILE: cwd,
      HOME: cwd,
    },
  });
  return r.out;
}

describe.runIf(built)("session flags + observability (V2-F3)", () => {
  it("--continue rehydrates the most recent conversation in a new process", { timeout: 120_000 }, async () => {
    // Session A: scaffold + one turn (a message that becomes the session).
    const a = await repl("remember: the deploy is on friday\n");
    expect(a).toContain("is awake");

    // Session B with --continue: the prior conversation is restored before the UI.
    const b = await repl("hello again\n", ["--continue"]);
    expect(b).toMatch(/resumed/i);
    expect(b).toMatch(/message\(s\)/);
  });

  it("/status prints a compact snapshot", { timeout: 120_000 }, async () => {
    const out = await repl("/status\n/exit\n");
    expect(out).toContain("model");
    expect(out).toContain("posture");
    expect(out).toContain("drift");
    expect(out).toContain("session");
  });

  it("/doctor diagnoses config, persona validity and memory integrity", { timeout: 120_000 }, async () => {
    const out = await repl("/doctor\n/exit\n", [], false);
    expect(out).toContain("personaxis doctor");
    expect(out).toMatch(/spec valid/i); // V5.P1.7: doctor absorbs /validate (+ /lint)
    expect(out).toMatch(/lint/i);
    expect(out).toMatch(/memory chain/i);
    expect(out).toMatch(/memory chain intact/i);
    // No model configured in the sandbox: a warning that says what that stops, not a crash.
    expect(out).toMatch(/no model configured/i);
  });

  it("/context reports gracefully with no model", { timeout: 120_000 }, async () => {
    const context = await repl("/context\n/exit\n", [], false);
    expect(context).toMatch(/offline|Context window/i);
  });

  /**
   * V8.A: `/cost` was absorbed into `/status → Usage` and is no longer a command.
   * Typing it must neither run nor answer "unknown command": it points at the new
   * home, and at the external door, because an agent cannot drive a menu.
   */
  it("a retired verb says where it went, and does not run", { timeout: 120_000 }, async () => {
    const out = await repl("/cost\n/exit\n");
    expect(out).toMatch(/now part of/i);
    expect(out).toMatch(/status/i);
  });

  it("/help groups commands by category and filters by query", { timeout: 120_000 }, async () => {
    const all = await repl("/help\n/exit\n");
    // V7.B: the surface is fourteen commands in four groups; absorbed verbs are hidden
    // from the default listing and reachable through `/help moved`.
    expect(all).toContain("Talk");
    expect(all).toContain("Identity");
    expect(all).toContain("/doctor");
    expect(all).toContain("/help moved");
    const filtered = await repl("/help drift\n/exit\n");
    expect(filtered).toMatch(/matching "drift"/i);
    expect(filtered).toContain("/drift");
    expect(filtered).not.toContain("/doctor");
  });

  it("custom slash commands are listed in /help and run as a turn", { timeout: 120_000 }, async () => {
    // The starter persona already exists from the earlier turns; drop a command file.
    const cmdDir = join(cwd, ".personaxis", "commands");
    mkdirSync(cmdDir, { recursive: true });
    writeFileSync(join(cmdDir, "standup.md"), "---\ndescription: Daily standup\n---\nGive me a standup summary of: $ARGUMENTS");

    const help = await repl("/help\n/exit\n");
    expect(help).toContain("Custom commands");
    expect(help).toContain("/standup");
    expect(help).toContain("Daily standup");

    // Running it dispatches a turn (offline responder acknowledges), no crash.
    const run = await repl("/standup the deploy pipeline\n/exit\n");
    expect(run).toMatch(/custom.*Daily standup/i);
  });
});
