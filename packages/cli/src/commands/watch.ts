/**
 * `personaxis watch`, the OPTIONAL local daemon that keeps a persona's compiled PERSONA.md fresh
 * (Fase 3). It complements host hooks (`personaxis observe`), which do the per-turn learning; the
 * daemon handles the two things a hook doesn't:
 *
 *   1. a human hand-edits `personaxis.md` → recompile PERSONA.md (debounced), and
 *   2. a heartbeat that recompiles if a governed self-edit left PERSONA.md stale.
 *
 * Runs on our configured model (the compile provider), never the host's. Cross-OS (Node fs.watch).
 * `--once` does a single reconcile pass then exits, ideal for a serverless cron / CI step.
 */

import { Command } from "commander";
import { watch as fsWatch, statSync } from "node:fs";
import chalk from "chalk";
import { readRecompilePending, slugFromPersonaPath } from "@personaxis/core";
import { runCompile } from "./compile.js";
import { resolveObservePersona } from "./observe.js";

async function recompile(personaPath: string, ifPending: boolean): Promise<boolean> {
  const slug = slugFromPersonaPath(personaPath);
  try {
    await runCompile(slug ? { slug, provider: "local", ifPending } : { root: true, provider: "local", ifPending });
    return true;
  } catch (e) {
    console.error(chalk.yellow("· recompile deferred:"), (e as Error).message);
    return false;
  }
}

/** One reconcile pass: recompile PERSONA.md if a self-edit marked it stale. Returns whether it ran. */
export async function reconcileOnce(personaPath: string): Promise<boolean> {
  if (!readRecompilePending(personaPath).pending) return false;
  console.log(chalk.dim("· drift pending, recompiling PERSONA.md…"));
  return recompile(personaPath, true);
}

export const watchCommand = new Command("watch")
  .description("Keep PERSONA.md fresh: recompile on manual spec edits + a drift heartbeat. Optional local daemon (hooks do per-turn learning).")
  .option("-p, --persona <path>", "Path to personaxis.md (default: <cwd>/.personaxis/personaxis.md)")
  .option("-i, --interval <seconds>", "Heartbeat interval for the drift check", "30")
  .option("--once", "Do a single reconcile pass then exit (serverless cron / CI)", false)
  .action(async (opts: { persona?: string; interval: string; once?: boolean }) => {
    const personaPath = resolveObservePersona(opts.persona);
    if (!personaPath) {
      console.error(chalk.red("Error:"), "no persona found, pass --persona or run inside a project with .personaxis/personaxis.md");
      process.exit(1);
    }

    if (opts.once) {
      const ran = await reconcileOnce(personaPath);
      console.log(ran ? chalk.green("✓ reconciled") : chalk.dim("· up to date (no drift)"));
      return;
    }

    console.log(chalk.green("✓"), `watching ${chalk.cyan(personaPath)}`, chalk.dim("· Ctrl+C to stop"));

    // 1. Debounced recompile when the human hand-edits the spec.
    let debounce: NodeJS.Timeout | undefined;
    let lastMtime = safeMtime(personaPath);
    try {
      fsWatch(personaPath, () => {
        const m = safeMtime(personaPath);
        if (m === lastMtime) return; // ignore duplicate fs events
        lastMtime = m;
        clearTimeout(debounce);
        debounce = setTimeout(() => {
          console.log(chalk.dim("· spec changed, recompiling PERSONA.md…"));
          void recompile(personaPath, false);
        }, 800);
      });
    } catch (e) {
      console.error(chalk.yellow("· file watch unavailable:"), (e as Error).message);
    }

    // 2. Heartbeat: recompile if a governed self-edit left PERSONA.md stale.
    const interval = Math.max(5, Number(opts.interval) || 30) * 1000;
    const timer = setInterval(() => void reconcileOnce(personaPath), interval);

    const stop = (): void => {
      clearInterval(timer);
      clearTimeout(debounce);
      console.log(chalk.dim("\n· stopped watching."));
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });

function safeMtime(p: string): number {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}
