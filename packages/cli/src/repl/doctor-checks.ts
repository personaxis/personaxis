/**
 * The `doctor` checks, as ONE implementation.
 *
 * They were written inside the slash command, which meant a `personaxis doctor` subcommand
 * would have had to re-do them, and two health checks that disagree are worse than one.
 * The slash command and the subcommand both call this; it takes a persona path and returns
 * lines, so it needs no session.
 *
 * Fully OFFLINE by default: the provider ping only runs when asked for, so a health check
 * never touches the network (or a key) without being told to.
 */

import chalk from "chalk";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  readState,
  extractEnvelopes,
  verifyMemoryChain,
  readMode,
  proposals,
  readRecompilePending,
} from "@personaxis/core";
import { loadPersonaFile, compiledPathFor } from "../load.js";
import { validatePersona } from "../schema.js";
import { lint } from "../linter/index.js";
import { discoverTree } from "./roster.js";
import { llmConfig } from "./config.js";
import { version } from "../generated/assets.js";
import { loadManifest, hashContent } from "../manifest.js";

export interface DoctorReport {
  lines: string[];
  failures: number;
  warnings: number;
}

/** Wraps a remedy to the terminal width (or 100 cols when piped), on word boundaries. */
function wrapFix(text: string): string[] {
  const width = Math.max(40, Math.min(process.stdout.columns ?? 100, 100) - 12);
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line && line.length + 1 + word.length > width) {
      out.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) out.push(line);
  return out;
}

/**
 * Every check that needs nothing but the disk.
 *
 * Split out so the Doctor MINIAPP can render it from a synchronous `lines()`
 * call and inherit the host's persona selector (V7.C1), while the slash command
 * and the subcommand add the opt-in provider ping on top. One implementation of
 * the checks, two surfaces.
 */
export function doctorChecksOffline(personaPath: string): DoctorReport {
  // Counted at the source rather than by grepping the rendered lines for a
  // glyph: now that remedies are printed under each finding, free prose could
  // otherwise be miscounted as a finding of its own.
  let failures = 0;
  let warnings = 0;
  const ok = (s: string): string => chalk.green("  ✓ ") + s;
  const bad = (s: string): string => (failures++, chalk.red("  ✗ ") + s);
  const warn = (s: string): string => (warnings++, chalk.yellow("  ! ") + s);
  // Every ✗ and ! is followed by its remedy. Wrapped, because an unwrapped
  // sentence past the terminal width is a remedy nobody reads.
  const fix = (s: string): string[] =>
    wrapFix(s).map((line, i) => chalk.dim(i === 0 ? `      fix: ${line}` : `           ${line}`));
  const rows: string[] = [];
  {

    // 1. spec validity (absorbs /validate).
    try {
      const v = validatePersona(loadPersonaFile(personaPath).data);
      rows.push(v.valid ? ok(`spec valid (${v.status})`) : bad(`spec ${v.status}: ${v.errors.length} error(s)`));
      // The remedy travels WITH the issue (ValidationIssue.fix), so a new
      // universal cannot land here as a bare "N error(s)".
      for (const e of v.errors.slice(0, 6)) {
        rows.push(chalk.dim(`      · ${e.field}: ${e.message}`));
        rows.push(...fix(e.fix));
      }
      if (v.errors.length > 6) rows.push(chalk.dim(`      · ${v.errors.length - 6} more, \`personaxis validate\` prints them all`));
      for (const w of v.warnings.slice(0, 3)) {
        rows.push(chalk.dim(`      ! ${w.field}: ${w.message}`));
        rows.push(...fix(w.fix));
      }
    } catch (e) {
      rows.push(bad(`persona load failed: ${(e as Error).message}`));
      rows.push(...fix("The file is unreadable or its frontmatter is not valid YAML. Check that it opens with --- on line 1 and uses spaces, not tabs."));
    }

    // 2. lint (absorbs /lint), tier-aware summary + top findings.
    try {
      const report = lint(readFileSync(personaPath, "utf-8"));
      rows.push(
        report.findings.length === 0
          ? ok("lint clean")
          : warn(`lint: ${report.summary.errors} error(s) · ${report.summary.warnings} warning(s) · ${report.summary.infos} info`),
      );
      // Info-level findings are counted but not expanded: the actionable ones
      // are errors and warnings, and burying them under notes helps nobody.
      // Errors before warnings: the truncation at 6 must not spend its budget on
      // notes while the blocking findings fall off the end.
      const rank = { error: 0, warning: 1, info: 2 } as const;
      const actionable = report.findings
        .filter((f) => f.severity !== "info")
        .sort((a, b) => rank[a.severity] - rank[b.severity]);
      for (const f of actionable.slice(0, 6)) {
        const c = f.severity === "error" ? chalk.red : chalk.yellow;
        rows.push(chalk.dim(`      · ${c(f.severity)} ${f.rule}: ${f.message}`));
        rows.push(...fix(f.fix));
      }
      if (actionable.length > 6) rows.push(chalk.dim(`      · ${actionable.length - 6} more, \`personaxis lint\` prints them all`));
    } catch (e) {
      rows.push(warn(`lint failed: ${(e as Error).message}`));
      rows.push(...fix("The linter could not read the file. Run `personaxis validate` first: a parse error there names the offending line."));
    }

    // 3. compiled document present + fresh.
    const compiled = compiledPathFor(personaPath);
    if (existsSync(compiled)) {
      rows.push(ok(`compiled doc present (${compiled})`));
    } else {
      rows.push(warn("no compiled document yet"));
      rows.push(...fix(`Run \`/compile\` (or \`personaxis compile\` outside the REPL) to write ${compiled}. Until it exists the spec governs nothing: the host agent has no file to read.`));
    }
    if (readRecompilePending(personaPath).pending) {
      rows.push(warn("spec changed since the last compile"));
      rows.push(...fix("Run `/compile` to regenerate the compiled document. Whoever reads it is currently seeing the persona as it was BEFORE your edit."));
    }

    // 4. memory chain integrity.
    const chain = verifyMemoryChain(personaPath);
    if (chain.ok) {
      rows.push(ok("memory chain intact"));
    } else {
      rows.push(bad(`memory chain broken at #${chain.brokenAt}`));
      rows.push(
        ...fix(
          `Entry #${chain.brokenAt} does not hash to its predecessor, so the log was edited outside the CLI (or a write was interrupted). The chain is append-only by design and there is no repair that preserves the guarantee. Inspect it with \`personaxis audit --json\`; if the divergence is explained, archive the file and start a fresh chain with \`personaxis state init\`. Every attestation covering entries after #${chain.brokenAt} should be treated as unverifiable.`,
        ),
      );
    }

    // 5. model configured (+ reachability ONLY with `/doctor net`).
    // Resolve the model for the persona being diagnosed, not for a session (there is none).
    const llm = llmConfig({
      personaPath,
      frontmatter: loadPersonaFile(personaPath).data as unknown as Record<string, unknown>,
    });
    if (!llm) {
      rows.push(warn("no model configured, running offline (heuristic)"));
      rows.push(
        ...fix(
          "Set one with `/config` (or `personaxis config set` outside). Without a model the persona still runs, but appraisal falls back to heuristics and `compile` emits the template instead of polished prose.",
        ),
      );
    } else {
      rows.push(ok(`model configured: ${llm.model} @ ${llm.endpoint}`));
    }
  }
  rows.push(chalk.dim(`  personaxis ${version}`));
  return { lines: rows, failures, warnings };
}

/**
 * The offline checks plus, only when asked, one provider probe.
 *
 * @param arg  the slash command's raw argument: an optional `@sub` address plus `net` to
 *             opt into the provider ping.
 */
export async function runDoctorChecks(rootPersonaPath: string, arg = ""): Promise<DoctorReport> {
  // V5.P1.7: persona selector (main by default, any sub via @address) + a fully
  // OFFLINE default: the provider ping only runs when "net" is asked for, so
  // /doctor never touches the network (or a key) without being told to.
  const parts = arg.trim().split(/\s+/).filter(Boolean);
  const wantNet = parts.includes("net");
  const target = parts.find((x) => x !== "net")?.replace(/^@/, "");
  let personaPath = rootPersonaPath;
  const header: string[] = [];
  if (target) {
    const hit = discoverTree(rootPersonaPath).find((s) => s.address === target);
    if (!hit) return { lines: [chalk.yellow(`  no sub-persona "@${target}" here.`)], failures: 1, warnings: 0 };
    personaPath = hit.path;
    header.push(chalk.dim(`  diagnosing @${target}`));
  }

  const report = doctorChecksOffline(personaPath);
  const rows = [...header, ...report.lines];
  let { failures, warnings } = report;
  const ok = (s: string): string => chalk.green("  ✓ ") + s;
  const warn = (s: string): string => (warnings++, chalk.yellow("  ! ") + s);
  const fix = (s: string): string[] =>
    wrapFix(s).map((line, i) => chalk.dim(i === 0 ? `      fix: ${line}` : `           ${line}`));

  const llm = llmConfig({
    personaPath,
    frontmatter: loadPersonaFile(personaPath).data as unknown as Record<string, unknown>,
  });
  // The version line is always last, so the probe result goes just above it.
  const tail = rows.pop() as string;
  if (llm && wantNet) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch(`${llm.endpoint.replace(/\/$/, "")}/models`, {
        headers: llm.apiKey ? { authorization: `Bearer ${llm.apiKey}` } : {},
        signal: ctrl.signal,
      }).finally(() => clearTimeout(timer));
      if (res.ok) {
        rows.push(ok(`provider reachable (HTTP ${res.status})`));
      } else {
        rows.push(warn(`provider answered HTTP ${res.status}`));
        rows.push(
          ...fix(
            res.status === 401 || res.status === 403
              ? `The endpoint is up but rejected the key (HTTP ${res.status}). Check the API key for ${llm.endpoint}; \`personaxis config\` shows which layer it came from.`
              : `The endpoint answered ${res.status} instead of listing models. Confirm ${llm.endpoint} is the base URL (no trailing /chat/completions) and that the provider is healthy.`,
          ),
        );
      }
    } catch (e) {
      rows.push(warn(`provider unreachable: ${(e as Error).message}`));
      rows.push(
        ...fix(
          `Nothing reached ${llm.endpoint}. If you are offline this is expected and the persona keeps working in heuristic mode. If not, check the endpoint URL and any proxy.`,
        ),
      );
    }
  } else if (llm) {
    rows.push(chalk.dim("      · /doctor net to also ping the provider"));
  }
  rows.push(tail);
  return { lines: rows, failures, warnings };
}
