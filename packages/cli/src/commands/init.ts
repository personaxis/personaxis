/**
 * `personaxis init`: this folder's persona, the way `/init` gives a repository its CLAUDE.md.
 *
 * A model reads the folder (its tree, the files that explain it, the personas already in it), takes what
 * you say it is for if you say anything, asks what that leaves open, and writes the persona and its
 * PERSONA.md (`runCreate`, the same process `create` runs for another persona). In the home folder it is
 * your personal persona, the one every project without its own inherits.
 *
 * Until 2026-10-08 `init` wrote fixed templates (a marketing persona, a blank form with TODO markers, a
 * user persona to fill in); they are archived outside the product, because every persona is a model's,
 * written from your sources.
 */

import { Command } from "commander";

import { runGenesisCommand, withGenesisOptions } from "./create.js";

export const initCommand = withGenesisOptions(
  new Command("init")
    .description("Create this folder's persona: a model reads the folder, asks what is missing and writes it")
    .argument("[intent...]", "What it is for, or anything to add (optional)"),
).action(async (intent: string[], opts: Record<string, unknown>) => runGenesisCommand(undefined, { ...opts, intent: intent.join(" "), root: true }));
