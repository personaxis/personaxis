/**
 * `personaxis sync` — reconcile this machine's persona state with another's.
 *
 * The portable user-clone lives on several machines (via git). This merges a
 * sibling machine's state.json into the local one without clobbering: union of
 * the audited mutation_log, last-writer-wins per field (clamped to envelopes),
 * conflicts reported. Identity is never touched.
 */

import { Command } from "commander";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import { loadPersona, ensureState, extractEnvelopes, readState, mergeState } from "@personaxis/core";

export const syncCommand = new Command("sync")
  .description("Reconcile local persona state with another machine's state.json (no clobber).")
  .argument("<other-state>", "Path to the other machine's state.json")
  .requiredOption("-p, --persona <path>", "Path to this machine's personaxis.md / PERSONA.md")
  .option("--dry-run", "Show the merge report without writing")
  .action((otherStatePath: string, opts: { persona: string; dryRun?: boolean }) => {
    const personaPath = resolve(opts.persona);
    const otherPath = resolve(otherStatePath);
    if (!existsSync(personaPath)) {
      console.error(chalk.red("Error:"), `persona not found at ${personaPath}`);
      process.exit(1);
    }
    if (!existsSync(otherPath)) {
      console.error(chalk.red("Error:"), `other state not found at ${otherPath}`);
      process.exit(1);
    }
    const handle = loadPersona(personaPath);
    const local = ensureState(handle);
    const other = readState(otherPath);
    const env = extractEnvelopes(handle.frontmatter);

    const { merged, conflicts } = mergeState(local, other, env.envelopes);

    console.log(chalk.bold(`\n  Reconcile ${handle.statePath}`));
    console.log(chalk.dim(`  ← ${otherPath}`));
    console.log(
      `  merged mutation_log: ${merged.mutation_log.length} entries · conflicts: ${conflicts.length}\n`,
    );
    for (const c of conflicts) {
      console.log(
        `  ${chalk.yellow("⚠")} ${c.field}: local ${c.a} vs incoming ${c.b} → ${chalk.bold(String(c.chosen))} ${chalk.dim(`(${c.reason})`)}`,
      );
    }
    if (opts.dryRun) {
      console.log(chalk.dim("\n  dry-run: nothing written.\n"));
      return;
    }
    writeFileSync(handle.statePath, JSON.stringify(merged, null, 2) + "\n", "utf-8");
    console.log(chalk.green("\n  ✓ merged state written (a __merge__ marker records the reconciliation).\n"));
  });
