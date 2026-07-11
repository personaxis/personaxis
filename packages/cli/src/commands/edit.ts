/**
 * `personaxis edit <dot-path> <value>` (F3.7), a SURGICAL, governed edit of one
 * value in the persona spec, without rewriting the file.
 *
 * The persona is atomic: its validity (cross-layer universals), its version (one
 * hash) and its readability are properties of the whole. So this command never
 * re-serializes the YAML (that would strip the author's comments); it edits the
 * one leaf line textually, then RE-VALIDATES the whole persona, an edit that
 * would break a universal (e.g. relaxing honesty enforcement) is REFUSED. Every
 * accepted edit is appended to the same self-edit ledger the actor uses, so
 * `/audit` shows human and actor changes on one timeline, and the compiled
 * PERSONA.md is marked stale for the next compile.
 *
 * Protected paths (identity, character, safety/honesty enforcement) require
 * `--force`, a human MAY edit them (they own the file) but not by accident.
 */

import { Command } from "commander";
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { relative } from "node:path";
import chalk from "chalk";
import matter from "gray-matter";
import { resolvePersonaSourcePath } from "../load.js";
import { validatePersona } from "../schema.js";
import {
  getAtPath,
  coerceLike,
  setScalarAtPath,
  editGate,
  isProtected,
  readMode,
  recordLedgerEvent,
  markRecompilePending,
} from "@personaxis/core";

export interface RunEditOptions {
  dotPath: string;
  value: string;
  slug?: string;
  force?: boolean;
  reason?: string;
  dryRun?: boolean;
}

export function runEdit(opts: RunEditOptions): void {
  let sourcePath: string;
  try {
    sourcePath = resolvePersonaSourcePath(opts.slug);
  } catch (err) {
    console.error(chalk.red("Error:"), (err as Error).message);
    process.exit(1);
  }

  const original = readFileSync(sourcePath, "utf-8");
  const fmMatch = original.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) {
    console.error(chalk.red("Error:"), "no YAML frontmatter found in the persona spec.");
    process.exit(1);
  }
  const yamlText = fmMatch[1];
  const data = (matter(original).data ?? {}) as Record<string, unknown>;

  const current = getAtPath(data, opts.dotPath);
  if (current === undefined) {
    console.error(chalk.red("Error:"), `path not found: ${chalk.cyan(opts.dotPath)}`);
    process.exit(1);
  }

  // Governance: a human owns the file, but protected/governed paths need --force.
  const mode = readMode(data, sourcePath);
  const gate = editGate(opts.dotPath, data, mode);
  const protectedPath = isProtected(opts.dotPath);
  if ((protectedPath || gate === "block") && !opts.force) {
    console.error(
      chalk.yellow("Refused:"),
      `${chalk.cyan(opts.dotPath)} is ${protectedPath ? "a PROTECTED path" : `governance-controlled (${gate})`}.`,
    );
    console.error(chalk.dim("  A human may edit it, but not by accident, re-run with --force if you intend to."));
    process.exit(2);
  }

  let coerced: unknown;
  try {
    coerced = coerceLike(opts.value, current);
  } catch (err) {
    console.error(chalk.red("Error:"), (err as Error).message);
    process.exit(1);
  }

  let edited;
  try {
    edited = setScalarAtPath(yamlText, data, opts.dotPath, coerced);
  } catch (err) {
    console.error(chalk.red("Error:"), (err as Error).message);
    process.exit(1);
  }

  const nextFile = original.replace(yamlText, edited.text);

  // The hard guarantee: an edit may NEVER break the spec's universals.
  const nextData = (matter(nextFile).data ?? {}) as Record<string, unknown>;
  const validation = validatePersona(nextData);
  if (!validation.valid) {
    console.error(chalk.red("Refused:"), `the edit would make the persona INVALID (${validation.status}).`);
    for (const e of (validation.errors ?? []).slice(0, 5)) console.error(chalk.dim(`  ${typeof e === "string" ? e : JSON.stringify(e)}`));
    console.error(chalk.dim("  A universal or required field must not be broken by an edit."));
    process.exit(3);
  }

  const rel = relative(process.cwd(), sourcePath).replace(/\\/g, "/");
  const preview = `${chalk.cyan(opts.dotPath)}: ${chalk.dim(JSON.stringify(edited.previous))} → ${chalk.bold(JSON.stringify(coerced))}`;

  if (opts.dryRun) {
    console.log(chalk.dim("dry-run, "), preview);
    console.log(chalk.dim(`  would write ${rel}; validation: ${validation.status}`));
    return;
  }

  writeFileSync(sourcePath, nextFile, "utf-8");
  recordLedgerEvent(sourcePath, {
    id: randomUUID(),
    op: "apply",
    ts: new Date().toISOString(),
    targetPath: opts.dotPath,
    toValue: coerced,
    rationale: opts.reason ?? "manual edit (personaxis edit)",
    actor: "human-operator",
  });
  markRecompilePending(sourcePath, `manual edit: ${opts.dotPath}`);

  console.log(chalk.green("✓"), preview);
  console.log(chalk.dim(`  ${rel} · validation ${validation.status} · audited · run 'personaxis compile' to refresh PERSONA.md`));
}

export const editCommand = new Command("edit")
  .description("Surgically edit ONE dot-path in the persona spec (governed + audited; comments preserved).")
  .argument("<dot-path>", "Dot-path to a scalar leaf, e.g. improvement_policy.mode or identity.short_name")
  .argument("<value>", "New value (coerced to the current value's type)")
  .option("--slug <slug>", "Edit a sub-persona's spec instead of the root")
  .option("--force", "Allow editing a protected/governance-controlled path")
  .option("--reason <text>", "Rationale recorded in the self-edit ledger")
  .option("--dry-run", "Preview the change (and validation) without writing")
  .action((dotPath: string, value: string, opts: { slug?: string; force?: boolean; reason?: string; dryRun?: boolean }) => {
    runEdit({ dotPath, value, slug: opts.slug, force: opts.force, reason: opts.reason, dryRun: opts.dryRun });
  });
