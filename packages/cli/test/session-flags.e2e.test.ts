/**
 * V2-F3.A/D: session-continuity flags (--continue / --resume) and the /status +
 * /doctor observability commands, end to end against the built binary.
 * PERSONAXIS_HOME + HOME are sandboxed and PERSONAXIS_NO_INHERIT stops the
 * git-like walk-up from attaching to the developer's real persona.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(__dirname, "..", "dist", "index.js");
const built = existsSync(CLI);

let cwd: string;
beforeAll(() => {
  cwd = mkdtempSync(join(tmpdir(), "pxs-flags-"));
});
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

function repl(input: string, args: string[] = []): string {
  return execFileSync("node", [CLI, ...args], {
    cwd,
    input,
    encoding: "utf-8",
    env: {
      ...process.env,
      FORCE_COLOR: "0",
      PERSONAXIS_NO_ANIM: "1",
      PERSONAXIS_HOME: join(cwd, ".pxs-home"),
      PERSONAXIS_NO_INHERIT: "1",
      USERPROFILE: cwd,
      HOME: cwd,
    },
  });
}

describe.runIf(built)("session flags + observability (V2-F3)", () => {
  it("--continue rehydrates the most recent conversation in a new process", { timeout: 120_000 }, () => {
    // Session A: scaffold + one turn (a message that becomes the session).
    const a = repl("remember: the deploy is on friday\n");
    expect(a).toContain("is awake");

    // Session B with --continue: the prior conversation is restored before the UI.
    const b = repl("hello again\n", ["--continue"]);
    expect(b).toMatch(/resumed/i);
    expect(b).toMatch(/message\(s\)/);
  });

  it("/status prints a compact snapshot", { timeout: 120_000 }, () => {
    const out = repl("/status\n/exit\n");
    expect(out).toContain("model");
    expect(out).toContain("posture");
    expect(out).toContain("drift");
    expect(out).toContain("session");
  });

  it("/doctor diagnoses config, persona validity and memory integrity", { timeout: 120_000 }, () => {
    const out = repl("/doctor\n/exit\n");
    expect(out).toContain("personaxis doctor");
    expect(out).toMatch(/persona valid/i);
    expect(out).toMatch(/memory chain intact/i);
    // No model configured in the sandbox → the offline warning, not a crash.
    expect(out).toMatch(/offline|no model/i);
  });

  it("/cost and /context report gracefully with no model", { timeout: 120_000 }, () => {
    const cost = repl("/cost\n/exit\n");
    expect(cost).toMatch(/no model turns|Session cost/i);
    const context = repl("/context\n/exit\n");
    expect(context).toMatch(/offline|Context window/i);
  });

  it("/help groups commands by category and filters by query", { timeout: 120_000 }, () => {
    const all = repl("/help\n/exit\n");
    expect(all).toContain("Session & context");
    expect(all).toContain("Menus & config");
    expect(all).toContain("/doctor");
    const filtered = repl("/help drift\n/exit\n");
    expect(filtered).toMatch(/matching "drift"/i);
    expect(filtered).toContain("/drift");
    expect(filtered).not.toContain("/doctor");
  });

  it("custom slash commands are listed in /help and run as a turn", { timeout: 120_000 }, () => {
    // The starter persona already exists from the earlier turns; drop a command file.
    const cmdDir = join(cwd, ".personaxis", "commands");
    mkdirSync(cmdDir, { recursive: true });
    writeFileSync(join(cmdDir, "standup.md"), "---\ndescription: Daily standup\n---\nGive me a standup summary of: $ARGUMENTS");

    const help = repl("/help\n/exit\n");
    expect(help).toContain("Custom commands");
    expect(help).toContain("/standup");
    expect(help).toContain("Daily standup");

    // Running it dispatches a turn (offline responder acknowledges), no crash.
    const run = repl("/standup the deploy pipeline\n/exit\n");
    expect(run).toMatch(/custom.*Daily standup/i);
  });
});
