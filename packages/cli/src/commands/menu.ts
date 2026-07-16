/**
 * `personaxis menu` (V2-F2): open the Command Center, the fullscreen alt-screen
 * TUI that hosts Model / State / Drift / Audit / Memory / Proposals / Fleet as
 * navigable sections. In a pipe / non-TTY it degrades to a one-line pointer
 * (the interactive surface needs a real terminal); the read-only data is
 * reachable headless via the individual subcommands (`config`, `state`, etc.).
 */

import { Command } from "commander";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { stdin, stdout } from "node:process";
import chalk from "chalk";
import { resolvePersonaSourcePath } from "../load.js";
import { runCommandCenter, type CenterSection } from "../command-center.js";

const SECTIONS: CenterSection[] = ["home", "model", "state", "drift", "audit", "memory", "proposals", "fleet"];

/** Sub-persona slugs under `.personaxis/personas/` (for the Fleet + assignment views). */
function personaSlugs(cwd: string): string[] {
  const dir = join(cwd, ".personaxis", "personas");
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

export const menuCommand = new Command("menu")
  .description("Open the Command Center: a stable fullscreen menu for model config, state, drift, audit, memory, proposals, and the persona fleet.")
  .option("--section <name>", `Open directly on a section (${SECTIONS.join(" | ")})`)
  .action(async (opts: { section?: string }) => {
    const section = (opts.section && SECTIONS.includes(opts.section as CenterSection) ? opts.section : "home") as CenterSection;

    if (!stdin.isTTY || !stdout.isTTY) {
      stdout.write(
        chalk.yellow("The Command Center needs an interactive terminal.") +
          chalk.dim("\n  Headless, use the subcommands directly: ") +
          chalk.cyan("personaxis config") +
          chalk.dim(" · ") +
          chalk.cyan("personaxis state show") +
          chalk.dim(" · ") +
          chalk.cyan("personaxis dash --once") +
          "\n",
      );
      return;
    }

    let personaPath: string | undefined;
    try {
      personaPath = resolvePersonaSourcePath();
    } catch {
      personaPath = undefined; // Model config still works with no persona here.
    }
    await runCommandCenter({ personaPath, personas: personaSlugs(process.cwd()), cwd: process.cwd(), section });
  });
