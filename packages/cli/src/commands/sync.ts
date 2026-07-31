/**
 * `personaxis sync`, reconcile this machine's persona state with another's.
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
import { loadPersona, ensureState, extractEnvelopes, readState, mergeState, mergeReport, deviceIdentity } from "@personaxis/core";

export const syncCommand = new Command("sync")
  .description("Reconcile local persona state with another machine's state.json (no clobber).")
  .argument("[other-state]", "Path to another machine's state.json (the pre-V8 file merge)")
  .requiredOption("-p, --persona <path>", "Path to this machine's personaxis.md / PERSONA.md")
  .option("--dry-run", "Show the merge report without writing")
  .option("--status", "What the per-device logs currently hold, and what a merge would produce")
  .option("--rebuild", "Recompute state.json from the per-device logs (it is a cache, not the source)")
  .action((otherStatePath: string | undefined, opts: { persona: string; dryRun?: boolean; status?: boolean; rebuild?: boolean }) => {
    const personaPath = resolve(opts.persona);
    if (opts.status || opts.rebuild) return void multiDevice(personaPath, Boolean(opts.rebuild), Boolean(opts.dryRun));
    if (!otherStatePath) {
      console.error(
        [
          chalk.yellow("  nothing to do."),
          chalk.dim("  personaxis sync --status            what each machine has contributed"),
          chalk.dim("  personaxis sync --rebuild           recompute state.json from those logs"),
          chalk.dim("  personaxis sync <other-state.json>  merge one machine's state file (pre-V8)"),
        ].join("\n"),
      );
      process.exit(2);
    }
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

/**
 * V8.C: the multi-device view, and the rebuild.
 *
 * Never silent. A merge that quietly changes a persona is indistinguishable from a bug,
 * so this reports which machines contributed, how many entries each chain holds, whether
 * any chain is broken, and how many mutations had to be clamped to stay in their envelope.
 */
function multiDevice(personaPath: string, rebuild: boolean, dryRun: boolean): void {
  if (!existsSync(personaPath)) {
    console.error(chalk.red("Error:"), `persona not found at ${personaPath}`);
    process.exit(1);
  }
  const handle = loadPersona(personaPath);
  const env = extractEnvelopes(handle.frontmatter);
  const report = mergeReport(personaPath, env.envelopes);
  const me = deviceIdentity();

  console.log(chalk.bold("\n  Devices that have written to this persona"));
  console.log(chalk.dim(`  this machine: ${me.label} (${me.id})\n`));

  if (!report.chains.length) {
    console.log(chalk.dim("  none yet: no per-device log exists here."));
    console.log(chalk.dim("  Logs appear as the persona changes. Carry the folder between machines with git,"));
    console.log(chalk.dim("  Syncthing or anything else: each machine writes only its own file, so they merge"));
    console.log(chalk.dim("  on read and never overwrite each other.\n"));
    return;
  }

  for (const c of report.chains) {
    const mine = c.device === me.id ? chalk.dim("  (this machine)") : "";
    console.log(
      c.ok
        ? `  ${chalk.green("✓")} ${c.device}  ${String(c.entries).padStart(4)} entr(ies)${mine}`
        : `  ${chalk.red("✗")} ${c.device}  chain broken at entry #${c.brokenAt}${mine}`,
    );
  }

  const broken = report.chains.filter((c) => !c.ok);
  if (broken.length) {
    console.log(
      chalk.yellow(`\n  ${broken.length} device(s) excluded from the merge.`) +
        chalk.dim(" A broken chain means entries were edited outside the CLI; folding them anyway"),
    );
    console.log(chalk.dim("  would make the tamper-evidence pointless."));
  }

  console.log(chalk.bold("\n  What a merge produces"));
  console.log(`  ${report.applied} mutation(s) applied · ${report.clamped} clamped to their envelope`);
  console.log(chalk.dim(`  contributed by: ${report.devices.join(", ") || "nobody"}`));

  if (!rebuild) {
    console.log(chalk.dim("\n  --rebuild writes this into state.json, which is a cache: the logs are the source.\n"));
    return;
  }
  if (dryRun) {
    console.log(chalk.dim("\n  dry-run: nothing written.\n"));
    return;
  }
  const state = ensureState(handle);
  writeFileSync(handle.statePath, JSON.stringify({ ...state, values: report.values }, null, 2) + "\n", "utf-8");
  console.log(
    chalk.green(`\n  ✓ state.json rebuilt from ${report.applied} entr(ies) across ${report.devices.length} device(s).\n`),
  );
}
