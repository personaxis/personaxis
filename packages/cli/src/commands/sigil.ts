/**
 * `personaxis sigil`, render a persona's living visual identity.
 *
 * The sigil + palette + motion are derived deterministically from the persona's
 * own spec (so every persona looks AND moves uniquely) and breathe with its live
 * state.json values. This is the differentiated "this persona is alive" view.
 */

import { Command } from "commander";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import { loadPersona, ensureState, extractEnvelopes, personaTheme, displayName } from "@personaxis/core";
import { sigilLines, envelopeBars, auraBar } from "@personaxis/tui/visual";

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
    const theme = personaTheme(handle.frontmatter);

    console.log(
      "\n  " + chalk.bold.ansi256(theme.palette.accent)(displayName(handle.frontmatter)) +
        chalk.dim(`  ·  sigil #${theme.seed.toString(16)}  ·  voice ${theme.voice.density}  ·  ${auraBar(theme, state.values)}\n`),
    );
    const frames = Math.max(1, Number(opts.frames) || 1);
    for (let f = 0; f < frames; f++) {
      console.log(sigilLines(theme, state.values, f).join("\n"));
      console.log("");
    }
    console.log(envelopeBars(theme, state.values, env.envelopes));
    console.log("");
  });
