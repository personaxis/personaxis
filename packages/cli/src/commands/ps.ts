/**
 * `personaxis ps` (V2-F4.1), the fleet view: which personas in this project someone is
 * holding right now, through what surface, plus their mutation count, tone and last change.
 * Read-only, no running process required.
 *
 * D6 corrected what this column meant. It used to read `.live.json`, a marker the loop
 * writes when state DRIFTS, and print "awake" or "idle" from it. Those are different
 * questions: a `serve` running for an hour without a single observation wrote nothing, so
 * the fleet called it idle while it held the persona, and a persona whose state had just
 * moved read as awake with nothing attached to it. Holders are `presence/`, one file per
 * instance; `.live.json` still answers what it always answered, when the state last moved.
 */

import { Command } from "commander";
import { existsSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import chalk from "chalk";
import { readLiveStatus } from "../fleet.js";
import { readLease, describeLease, isOwnLease, livePresence, machineId, type Presence } from "@personaxis/core";

/** The surfaces holding a persona, deduped: "repl · serve". Empty when nobody is. */
export function heldBy(instances: Presence[]): string {
  return [...new Set(instances.map((p) => p.host))].join(" · ");
}

/**
 * The detail line under a held persona, or nothing when there is none worth printing.
 *
 * Two facts earn a line. A holder on ANOTHER machine, because that is the collision this
 * view exists to reveal and the row alone cannot show it. And what the holders are doing,
 * because "repl" says a surface while "answering" says the persona is busy right now.
 */
export function presenceDetail(instances: Presence[], selfDevice = machineId()): string {
  const elsewhere = instances.filter((p) => p.deviceId !== selfDevice);
  const parts: string[] = [];
  if (elsewhere.length) {
    parts.push(`also on ${[...new Set(elsewhere.map((p) => p.machine))].join(", ")}`);
  }
  const doing = [...new Set(instances.map((p) => p.activity).filter((a): a is string => !!a && a !== "idle"))];
  if (doing.length) parts.push(doing.join(", "));
  return parts.join(" · ");
}

export const psCommand = new Command("ps")
  .description("fleet view: who is holding each persona here, through what surface, mutations, tone, last change")
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
    console.log(chalk.bold("  PERSONA             HELD BY        MUT   TONE    LAST CHANGE"));
    for (const { slug, path } of personas) {
      const s = readLiveStatus(path);
      const instances = livePresence(path);
      const held = instances.length ? chalk.green(heldBy(instances).padEnd(13)) : chalk.dim("nobody".padEnd(13));
      const tone = s.values?.["mood.tone"];
      const toneStr = tone === undefined ? "  -  " : tone.toFixed(2).padStart(5);
      const last = s.ts ? s.ts.slice(11, 19) : "  -  ";
      const mut = s.mutations !== undefined ? String(s.mutations) : "-";
      console.log(`  ${chalk.cyan(slug.padEnd(18))}  ${held}  ${mut.padStart(3)}   ${toneStr}   ${chalk.dim(last)}`);
      const detail = presenceDetail(instances);
      if (detail) console.log(`    ${chalk.dim(detail)}`);
      // A held write lease changes what the OTHER machines may do, so a fleet view that
      // omits it would show a persona as available when it is not.
      const lease = readLease(path);
      if (lease) {
        const who = isOwnLease(lease) ? chalk.dim("write lease: ") : chalk.yellow("write lease: ");
        console.log(`    ${who}${chalk.dim(describeLease(lease))}`);
      }
    }
  });
