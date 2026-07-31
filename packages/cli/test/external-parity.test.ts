/**
 * EXTERNAL PARITY: a coding agent cannot drive menus.
 *
 * Everything the TUI can do must either have a non-interactive subcommand, or be honestly
 * declared as belonging to a live session. The declaration lives on each command rather
 * than in a separate list, so a NEW slash command cannot quietly join without answering the
 * question: an unset `external` fails to compile, and a name that points at a subcommand
 * that does not exist fails here.
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS, EXTERNAL_DOOR } from "../src/repl/commands.js";

const CLI = join(process.cwd(), "dist", "index.js");

/** Top-level subcommands commander actually registers, read from the real `--help`. */
function externalSubcommands(): Set<string> {
  const help = execFileSync(process.execPath, [CLI, "--help"], { encoding: "utf-8" });
  const body = help.slice(help.indexOf("Commands:"));
  const names = new Set<string>();
  for (const line of body.split("\n").slice(1)) {
    const m = line.match(/^\s{2}([a-z][a-z-]*)\b/);
    if (m) names.add(m[1]);
  }
  return names;
}

describe("every TUI capability is reachable without the TUI", () => {
  const subcommands = externalSubcommands();

  it("the CLI exposes the subcommands this test reads (sanity)", () => {
    for (const known of ["create", "compile", "validate", "state", "serve"]) {
      expect(subcommands, `--help did not list ${known}`).toContain(known);
    }
  });

  it("EVERY slash command declares how an agent reaches it", () => {
    for (const c of COMMANDS) {
      expect(c.external, `/${c.name} does not declare an external gate`).toBeTruthy();
    }
  });

  it("every declared gate names a subcommand that really exists", () => {
    const missing: string[] = [];
    for (const c of COMMANDS) {
      if (c.external === "session-only") continue;
      // A gate may be a subcommand plus arguments ("state drift"); the first word is the
      // command commander has to know about.
      const head = c.external.split(" ")[0];
      if (!subcommands.has(head)) missing.push(`/${c.name} → personaxis ${c.external}`);
    }
    expect(missing, `these gates point at subcommands that do not exist:\n  ${missing.join("\n  ")}`).toEqual([]);
  });

  it("a session-only command must SAY why, so the gap is a decision and not an omission", () => {
    for (const c of COMMANDS) {
      if (c.external !== "session-only") continue;
      expect(c.why, `/${c.name} is session-only without a reason`).toBeTruthy();
      expect((c.why ?? "").length, `/${c.name}'s reason is too thin to be one`).toBeGreaterThan(20);
    }
  });

  it("the agent-usage guide lists every externally reachable command", () => {
    // The guide is generated from this same table; if a command is added and the guide is
    // not refreshed, an agent reading the docs would not know the door exists.
    const guide = readFileSync(join(process.cwd(), "..", "..", "docs", "guides", "agent-usage.md"), "utf-8");
    const missing = COMMANDS.filter((c) => c.external !== "session-only" && !guide.includes(`\`/${c.name}\``)).map((c) => c.name);
    expect(missing, `docs/guides/agent-usage.md does not mention: ${missing.join(", ")}`).toEqual([]);
  });

  /**
   * The point of the whole exercise: the capabilities an agent actually needs (read the
   * persona, check it, change it, watch it) are all reachable from a script.
   */
  it("the capabilities an agent needs are reachable without the TUI", () => {
    // V8.A retired several slash commands into the views that absorbed them. The
    // CAPABILITY still has to be callable from a shell, so a retired name must name
    // its external door: an agent cannot drive a menu.
    const mustBeExternal = ["create", "compile", "validate", "lint", "status", "audit", "drift", "improve", "memory", "doctor"];
    for (const name of mustBeExternal) {
      const c = COMMANDS.find((x) => x.name === name);
      if (c) {
        expect(c.external, `/${name} must be reachable outside the TUI`).not.toBe("session-only");
      } else {
        expect(EXTERNAL_DOOR[name], `${name} was absorbed and must still name its external door`).toBeTruthy();
      }
    }
  });
});
