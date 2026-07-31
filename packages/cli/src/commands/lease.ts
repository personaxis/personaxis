/**
 * `personaxis lease` (V8.D4), the write lease from outside the TUI.
 *
 * The lease exists so that one machine can declare itself the only author for a stretch.
 * That declaration is worth nothing if only the interactive REPL can make it: the long
 * unattended runs that most want it are exactly the ones nobody is sitting in front of.
 * Hence the same three verbs an agent or a CI job can call.
 */

import { Command } from "commander";
import chalk from "chalk";
import { acquireLease, releaseLease, readLease, describeLease, isOwnLease } from "@personaxis/core";
import { loadPersonaFile } from "../load.js";

function personaPathOr(explicit?: string): string {
  return loadPersonaFile(explicit).path;
}

export const leaseCommand = new Command("lease")
  .description("optional exclusive write lease: show, take, or release it")
  .argument("[action]", "status | take | release", "status")
  .option("-f, --file <path>", "persona file (defaults to the resolved persona)")
  .option("--reason <text>", "why you are taking it; shown to whoever gets blocked")
  .option("--force", "break a hold another machine left behind (recorded)")
  .option("--json", "machine-readable output")
  .action((action: string, opts: { file?: string; reason?: string; force?: boolean; json?: boolean }) => {
    const personaPath = personaPathOr(opts.file);
    const emit = (payload: Record<string, unknown>, human: string, code = 0): void => {
      console.log(opts.json ? JSON.stringify(payload, null, 2) : human);
      if (code) process.exitCode = code;
    };

    if (action === "status") {
      const held = readLease(personaPath);
      if (!held) return emit({ held: false, mayWrite: true }, chalk.dim("no lease held; every instance may write."));
      return emit(
        { held: true, mine: isOwnLease(held), lease: held, mayWrite: isOwnLease(held) },
        `${chalk.bold("lease")} ${chalk.dim("held by")} ${describeLease(held)}`,
      );
    }

    if (action === "take") {
      // "manual": this process exits at once, so a heartbeat-expiring lease would be gone
      // before the next command ran. A hold taken by hand is released by hand.
      const r = acquireLease(personaPath, { reason: opts.reason, holder: "manual", force: opts.force });
      if (!r.ok) {
        // Exit 1, because a script that assumed it got the lease must be able to tell.
        return emit(
          { ok: false, heldBy: r.heldBy },
          chalk.yellow("refused: ") +
            chalk.dim(`${describeLease(r.heldBy)}\n  it frees when that instance exits, or with `) +
            chalk.cyan("personaxis lease take --force"),
          1,
        );
      }
      const broke = r.how === "forced" && r.brokeHold ? chalk.dim(` (broke the hold of ${describeLease(r.brokeHold)})`) : "";
      return emit(
        { ok: true, how: r.how, lease: r.lease, ...(r.brokeHold ? { brokeHold: r.brokeHold } : {}) },
        chalk.green("✓ ") + `lease ${r.how}${broke}` + chalk.dim("\n  release it with ") + chalk.cyan("personaxis lease release"),
      );
    }

    if (action === "release") {
      const freed = releaseLease(personaPath);
      return emit(
        { ok: freed },
        freed ? chalk.green("✓ ") + "lease released" : chalk.dim("nothing to release (you do not hold it)"),
      );
    }

    // Naming the valid actions beats "invalid argument": the fix is in the message.
    console.error(chalk.red(`unknown action "${action}"`) + chalk.dim("; use status, take or release."));
    process.exitCode = 2;
  });
