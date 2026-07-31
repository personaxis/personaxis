/**
 * `personaxis ps` (V2-F4.1), the fleet view: which personas in this project are
 * awake vs idle (from the `.live.json` presence marker), their mutation count,
 * current tone, and last activity. Read-only, no running process required.
 */

import { Command } from "commander";
import { existsSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import chalk from "chalk";
import { readLiveStatus } from "../fleet.js";
import { readLease, describeLease, isOwnLease } from "@personaxis/core";

export const psCommand = new Command("ps")
  .description("fleet view: which personas here are awake/idle, mutations, tone, last activity")
  .action(() => {
    const base = resolve(process.cwd(), ".personaxis");
    const personas: Array<{ slug: string; path: string }> = [];
    const root = join(base, "personaxis.md");
    if (existsSync(root)) personas.push({ slug: "(root)", path: root });
    const subsDir = join(base, "personas");
    if (existsSync(subsDir)) {
      for (const name of readdirSync(subsDir)) {
        const p = join(subsDir, name, "personaxis.md");
        if (existsSync(p)) personas.push({ slug: name, path: p });
      }
    }
    if (!personas.length) {
      console.log(chalk.dim("no personas here. `personaxis init` or `personaxis create` to make one."));
      return;
    }
    console.log(chalk.bold("  PERSONA             STATUS   MUT   TONE    LAST"));
    for (const { slug, path } of personas) {
      const s = readLiveStatus(path);
      const status = s.awake ? chalk.green("awake") : chalk.dim("idle ");
      const tone = s.values?.["mood.tone"];
      const toneStr = tone === undefined ? "  -  " : tone.toFixed(2).padStart(5);
      const last = s.ts ? s.ts.slice(11, 19) : "  -  ";
      const mut = s.mutations !== undefined ? String(s.mutations) : "-";
      console.log(`  ${chalk.cyan(slug.padEnd(18))}  ${status}   ${mut.padStart(3)}   ${toneStr}   ${chalk.dim(last)}`);
      // A held write lease changes what the OTHER machines may do, so a fleet view that
      // omits it would show a persona as available when it is not.
      const lease = readLease(path);
      if (lease) {
        const who = isOwnLease(lease) ? chalk.dim("write lease: ") : chalk.yellow("write lease: ");
        console.log(`    ${who}${chalk.dim(describeLease(lease))}`);
      }
    }
  });
