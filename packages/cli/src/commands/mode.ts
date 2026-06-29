/**
 * `personaxis mode [locked|suggesting|autonomous]` — view or set a persona's
 * self-improvement posture (`improvement_policy.mode`), the single switch that
 * governs whether the spec can evolve itself:
 *
 *   locked      — the spec never self-edits; only humans change it.
 *   suggesting  — the persona PROPOSES edits; they queue for approval (consensus).
 *   autonomous  — proposals auto-apply, still gated (consensus + protected paths).
 *
 * Writing is done by TARGETED TEXT SURGERY on the YAML frontmatter so the spec's
 * extensive tier/consumer COMMENTS are preserved (a gray-matter round-trip would
 * strip them). The runtime reads `frontmatter.improvement_policy.mode` (readMode),
 * so an inline block is authoritative even when the persona also references
 * `improvement_policy_location` (policy.yaml).
 */

import { readFileSync, writeFileSync } from "fs";
import { relative } from "path";
import { Command } from "commander";
import chalk from "chalk";
import { resolvePersonaSourcePath } from "../load.js";
import { readMode, readMemoryTypes, appendAutobiographical, type ImprovementMode } from "@personaxis/core";
import matter from "gray-matter";

export const MODES: ImprovementMode[] = ["locked", "suggesting", "autonomous"];

export function isMode(s: string): s is ImprovementMode {
  return (MODES as string[]).includes(s);
}

/** Set `improvement_policy.mode` in the frontmatter text, preserving comments. */
export function setModeInFrontmatter(raw: string, mode: ImprovementMode): string {
  const m = raw.match(/^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n)([\s\S]*)$/);
  if (!m) throw new Error("persona spec has no YAML frontmatter (--- … ---)");
  const [, open, fmBody, close, body] = m;
  let fm = fmBody;

  if (/^improvement_policy:/m.test(fm)) {
    // Replace (or insert) the `mode:` line inside the existing block.
    fm = fm.replace(/^(improvement_policy:[^\n]*\n)((?:[ \t]+[^\n]*\n?)*)/m, (_whole, head: string, blk: string) => {
      const next = /^[ \t]+mode:/m.test(blk)
        ? blk.replace(/^([ \t]+)mode:[ \t]*["']?[A-Za-z]+["']?[ \t]*(#[^\n]*)?$/m, `$1mode: ${mode}`)
        : `  mode: ${mode}\n` + blk;
      return head + next;
    });
  } else {
    fm = fm.replace(/\s*$/, "") + `\nimprovement_policy:\n  mode: ${mode}`;
  }
  return open + fm + close + body;
}

export interface ModeResult {
  path: string;
  previous: ImprovementMode;
  current: ImprovementMode;
  changed: boolean;
}

/** Read (newMode undefined) or set the improvement mode. Returns the outcome. */
export function runMode(target?: string, newMode?: ImprovementMode): ModeResult {
  const path = resolvePersonaSourcePath(target);
  const raw = readFileSync(path, "utf-8");
  const previous = readMode(matter(raw).data as Record<string, unknown>);
  if (!newMode || newMode === previous) {
    return { path, previous, current: previous, changed: false };
  }
  writeFileSync(path, setModeInFrontmatter(raw, newMode), "utf-8");
  // autobiographical — a change of self-improvement posture is an identity-level milestone.
  if (readMemoryTypes(matter(raw).data as Record<string, unknown>).autobiographical) {
    try {
      appendAutobiographical(path, { event: "improvement mode changed", detail: `${previous} → ${newMode}`, tags: ["mode"] });
    } catch {
      /* milestone logging is best-effort */
    }
  }
  return { path, previous, current: newMode, changed: true };
}

export const modeCommand = new Command("improve")
  .description("View or set self-improvement posture (improvement_policy.mode)")
  .argument("[mode]", "locked | suggesting | autonomous (omit to view)")
  .option("-p, --persona <path>", "Path to personaxis.md")
  .action((mode: string | undefined, opts: { persona?: string }) => {
    if (mode && !isMode(mode)) {
      console.error(chalk.red("Error:"), `mode must be one of ${MODES.join(" | ")}`);
      process.exit(1);
    }
    const r = runMode(opts.persona, mode as ImprovementMode | undefined);
    const where = chalk.dim(relative(process.cwd(), r.path));
    if (r.changed) {
      console.log(`${chalk.green("✓")} improvement_policy.mode: ${chalk.dim(r.previous)} → ${chalk.bold(r.current)}  ${where}`);
    } else {
      console.log(`improvement_policy.mode = ${chalk.bold(r.current)}  ${where}`);
      console.log(chalk.dim(`  set with: personaxis mode <${MODES.join("|")}>`));
    }
  });
