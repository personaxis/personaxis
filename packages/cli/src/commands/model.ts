/**
 * `personaxis model` (V5.P1.8): the model surface for the OUTSIDE of the TUI,
 * scriptable by humans, CI and coding agents (inside the app, /model opens the
 * provider menu instead).
 *
 *   personaxis model                      show the resolved model for the main
 *                                         persona and every sub (and who set it)
 *   personaxis model set <name>           set the model name (global by default)
 *   personaxis model set <key> <value>    endpoint | model | key | key-env
 *     --persona <slug|main>               scope the override to one persona
 *     --project                           write the project config, not global
 */

import { Command } from "commander";
import chalk from "chalk";
import { existsSync } from "node:fs";
import { resolveModel } from "@personaxis/core";
import { resolvePersonaOption } from "../load.js";
import { discoverTree } from "../repl/roster.js";
import { setModelSetting } from "../config.js";

const KEYS = ["endpoint", "model", "key", "key-env"] as const;

function showResolved(personaOpt: string | undefined, json = false): void {
  const mainPath = resolvePersonaOption(personaOpt ?? ".personaxis/personaxis.md");
  if (!existsSync(mainPath)) {
    if (json) return void console.log(JSON.stringify({ error: "no persona found" }));
    console.log(chalk.yellow("no persona here; run inside a project with .personaxis/ or pass --persona <path>"));
    return;
  }
  const resolveFor = (p: string) => resolveModel({ cwd: process.cwd(), personaPath: p });
  if (json) {
    // V5.P5.1: machine-readable parity for agents/CI (never leaks the api key).
    const entry = (p: string) => {
      const r = resolveFor(p);
      return r ? { model: r.model, endpoint: r.endpoint } : null;
    };
    const out: Record<string, { model: string; endpoint: string } | null> = { main: entry(mainPath) };
    for (const sub of discoverTree(mainPath)) out[`@${sub.address}`] = entry(sub.path);
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  const label = (p: string): string => {
    const r = resolveFor(p);
    return r ? `${r.model} @ ${r.endpoint}` : chalk.dim("(offline, no model resolves)");
  };
  console.log(`${chalk.cyan("main".padEnd(14))} ${label(mainPath)}`);
  for (const sub of discoverTree(mainPath)) {
    console.log(`${chalk.cyan(("@" + sub.address).padEnd(14))} ${label(sub.path)}`);
  }
  console.log(chalk.dim("set: personaxis model set <name> [--persona <slug|main>] [--project]"));
}

export const modelCommand = new Command("model")
  .description("Show the resolved model per persona, or set model config (scriptable; inside the app use /model)")
  .option("--persona <path>", "Path to the main persona spec (defaults to .personaxis/personaxis.md)")
  .option("--json", "Machine-readable output (model + endpoint per persona; keys never included)", false)
  .action((opts: { persona?: string; json?: boolean }) => showResolved(opts.persona, opts.json));

modelCommand
  .command("set")
  .description("Set a model field: set <name> | set <endpoint|model|key|key-env> <value>")
  .argument("<keyOrValue>", "a field name, or directly the model name")
  .argument("[value]", "the value when the first argument is a field name")
  .option("--persona <slug|main>", "Scope the override to one persona ('main' = the project's main persona)")
  .option("--project", "Write the project config (.personaxis/config.json) instead of the global one", false)
  .action((keyOrValue: string, value: string | undefined, opts: { persona?: string; project?: boolean }) => {
    // `model set <name>` convenience: one argument means "the model name".
    const key = value === undefined ? "model" : keyOrValue;
    const val = value === undefined ? keyOrValue : value;
    if (!(KEYS as readonly string[]).includes(key)) {
      console.error(chalk.red(`unknown field "${key}" (use: ${KEYS.join(" | ")})`));
      process.exitCode = 2;
      return;
    }
    // "main" scopes to the shared local section (what the main persona resolves
    // from when it has no per-slug override); a slug writes personas.<slug>.
    const personaSlug = opts.persona && opts.persona !== "main" ? opts.persona.replace(/^@/, "") : undefined;
    try {
      setModelSetting(key, val, !opts.project, personaSlug);
      const where = `${opts.project ? "project .personaxis" : "global ~/.personaxis"}/config.json${personaSlug ? ` · personas.${personaSlug}` : ""}`;
      const shown = key === "key" ? val.slice(0, 3) + "…" + val.slice(-2) : val;
      console.log(chalk.green(`✓ ${key} = ${shown}`) + chalk.dim(`  (${where})`));
    } catch (e) {
      console.error(chalk.red((e as Error).message));
      process.exitCode = 1;
    }
  });
