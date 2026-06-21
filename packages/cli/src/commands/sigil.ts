/**
 * `personaxis sigil` — render a persona's living visual identity.
 *
 * The sigil is derived deterministically from the persona's own personaxis.md
 * (so every persona looks unique) and breathes with its live state.json values.
 * This is the differentiated "this persona is alive" visualization.
 */

import { Command } from "commander";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import { loadPersona, ensureState, extractEnvelopes, sigilParams, displayName } from "@personaxis/core";
import { sigilBlock, envelopeBars } from "../repl/render.js";

export const sigilCommand = new Command("sigil")
  .description("Render a persona's deterministic, state-aware ASCII sigil + envelope panel.")
  .option("-p, --persona <path>", "Path to personaxis.md / PERSONA.md", ".personaxis/personaxis.md")
  .option("--frames <n>", "Number of breathing frames to print", "1")
  .action((opts: { persona: string; frames: string }) => {
    const path = resolve(opts.persona);
    if (!existsSync(path)) {
      console.error(chalk.red("Error:"), `persona not found at ${path}`);
      process.exit(1);
    }
    const handle = loadPersona(path);
    const state = ensureState(handle);
    const env = extractEnvelopes(handle.frontmatter);

    console.log(chalk.bold.magentaBright(`\n  ${displayName(handle.frontmatter)}`));
    console.log(chalk.dim(`  sigil #${sigilParams(handle.frontmatter).seed.toString(16)}\n`));
    const frames = Math.max(1, Number(opts.frames) || 1);
    for (let f = 0; f < frames; f++) {
      console.log(sigilBlock(handle.frontmatter, state.values, f));
      console.log("");
    }
    console.log(envelopeBars(state.values, env.envelopes));
    console.log("");
  });
