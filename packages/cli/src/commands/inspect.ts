/**
 * NON-INTERACTIVE GATES: the capabilities an agent needs, without the TUI.
 *
 * A coding agent (Claude Code, Codex, a CI job) cannot drive a menu, so every capability
 * worth automating needs a subcommand that prints and exits. These are the six that had
 * only a slash command: status, audit, memory, doctor, goal, review.
 *
 * They deliberately reuse the SAME collectors the miniapps render, rather than
 * re-querying the engine: two implementations of "what is this persona's status" would
 * disagree the first time one of them changed, and the whole point of the parity contract
 * is that the terminal and the pipe answer identically. Each takes `--json` for machines
 * and prints the human lines otherwise.
 */

import { Command } from "commander";
import chalk from "chalk";
import { readState, proposals, applySelfEdit, rejectSelfEdit, readMemoryTypes } from "@personaxis/core";
import { resolve } from "node:path";
import { resolvePersonaSourcePath } from "../load.js";
import { makeCtx } from "../repl/session.js";
import { makeMeter, readGoalText } from "../repl/config.js";
import { loadPersona } from "@personaxis/core";
import { statusLines } from "../repl/views/settings-data.js";
import { auditLines, AUDIT_TABS } from "../repl/views/audit-data.js";
import { structuralReport, behavioralReport, driftTextLines } from "../repl/views/drift-view.js";
import { memoryKindRows } from "../repl/views/memory-data.js";
import { runDoctorChecks } from "../repl/doctor-checks.js";
import type { Ctx } from "../repl/types.js";
import type { TabLine } from "../repl/views/tabbed.js";

/**
 * Say which persona is being answered for when it was NOT found in the current directory.
 *
 * Persona discovery walks up like git, so running one of these in a directory with no
 * persona answers about an ancestor's, often the user's own global one. The REPL announces
 * that; these did not, so `personaxis memory` in an unrelated folder could print somebody
 * else's memory with nothing saying whose. Written to stderr, so `--json` on stdout stays
 * machine-clean.
 */
function noteInheritance(personaPath: string): void {
  const here = resolve(process.cwd());
  if (resolve(personaPath).startsWith(here)) return;
  process.stderr.write(chalk.dim(`  persona: ${personaPath} (inherited from an ancestor directory)
`));
}

/** A session-less context for the collectors. No model is called; nothing is written. */
function inspectCtx(personaArg?: string): Ctx {
  const path = resolvePersonaSourcePath(personaArg);
  if (!personaArg) noteInheritance(path);
  return makeCtx(path, makeMeter());
}

const strip = (s: string): string => s.replace(/\[[0-9;]*m/g, "");
const text = (l: TabLine): string => (typeof l === "string" ? l : `  ${l.label.padEnd(22)} ${l.value ?? ""}`);

function emit(lines: string[], json: unknown, asJson: boolean): void {
  if (asJson) console.log(JSON.stringify(json, null, 2));
  else for (const l of lines) console.log(l);
}

export const statusCommand = new Command("status")
  .description("Snapshot of a persona right now: identity, model, posture, drift, memory, mutations")
  .option("-p, --persona <path>", "Persona to inspect (defaults to the one in scope)")
  .option("--json", "Emit machine-readable JSON")
  .action((opts: { persona?: string; json?: boolean }) => {
    const ctx = inspectCtx(opts.persona);
    const lines = statusLines(ctx);
    const st = readState(ctx.handle.statePath);
    emit(
      lines,
      {
        persona: ctx.name,
        specPath: ctx.handle.personaPath,
        improve: ctx.mode,
        values: st.values,
        mutations: st.mutation_log.length,
        memoryTypes: readMemoryTypes(ctx.handle.frontmatter as Record<string, unknown>),
        lines: lines.map(strip),
      },
      !!opts.json,
    );
  });

export const auditCommand = new Command("audit")
  .description("The ledger: mutation timeline, memory-chain integrity, self-edits, evaluations")
  .option("-p, --persona <path>", "Persona to inspect (defaults to the one in scope)")
  .option("--tab <name>", `One of: ${AUDIT_TABS.join(" | ")} (default: all)`)
  .option("--json", "Emit machine-readable JSON")
  .action((opts: { persona?: string; tab?: string; json?: boolean }) => {
    const ctx = inspectCtx(opts.persona);
    const wanted = opts.tab
      ? [AUDIT_TABS.findIndex((t) => t.toLowerCase() === opts.tab!.toLowerCase())].filter((i) => i >= 0)
      : AUDIT_TABS.map((_, i) => i);
    if (opts.tab && wanted.length === 0) {
      console.error(chalk.red("Unknown tab:"), opts.tab, chalk.dim(`(known: ${AUDIT_TABS.join(", ")})`));
      process.exit(1);
    }
    const out: string[] = [];
    const byTab: Record<string, string[]> = {};
    for (const i of wanted) {
      const rendered = auditLines(ctx, i).map(text);
      out.push(chalk.bold(`  ${AUDIT_TABS[i]}`), ...rendered, "");
      byTab[AUDIT_TABS[i]] = rendered.map(strip);
    }
    emit(out, { persona: ctx.name, tabs: byTab }, !!opts.json);
  });

export const memoryCommand = new Command("memory")
  .description("What this persona remembers, by kind (episodic, semantic, procedural, …)")
  .option("-p, --persona <path>", "Persona to inspect (defaults to the one in scope)")
  .option("--json", "Emit machine-readable JSON")
  .action((opts: { persona?: string; json?: boolean }) => {
    const ctx = inspectCtx(opts.persona);
    const kinds = memoryKindRows(ctx);
    const on = kinds.filter((k) => k.enabled);
    emit(
      on.length
        ? on.map((k) => `  ${chalk.cyan(k.name.padEnd(16))} ${k.count} entr${k.count === 1 ? "y" : "ies"}  ${chalk.dim(k.file)}`)
        : [chalk.dim("  no memory kinds enabled for this persona")],
      {
        persona: ctx.name,
        kinds: kinds.map((k) => ({ kind: k.name, enabled: k.enabled, count: k.count, file: k.file })),
      },
      !!opts.json,
    );
  });

export const driftCommand = new Command("drift")
  .description("How far a persona has moved from what it declared: continuous, structural and behavioral")
  .option("-p, --persona <path>", "Persona to inspect (defaults to the one in scope)")
  .option("--json", "Emit machine-readable JSON")
  .action((opts: { persona?: string; json?: boolean }) => {
    const ctx = inspectCtx(opts.persona);
    const structural = structuralReport(ctx);
    const behavioral = behavioralReport(ctx);
    emit(
      driftTextLines(ctx),
      {
        persona: ctx.name,
        structural: {
          global: structural.global,
          changes: structural.changes.map((c) => ({
            path: c.path,
            layer: c.layer,
            kind: c.kind,
            magnitude: c.magnitude,
            from: c.from,
            to: c.to,
            policy: c.policy,
          })),
        },
        behavioral,
      },
      !!opts.json,
    );
  });

export const goalCommand = new Command("goal")
  .description("Show the persona's standing goal (set it from the session with /goal)")
  .option("-p, --persona <path>", "Persona to inspect (defaults to the one in scope)")
  .option("--json", "Emit machine-readable JSON")
  .action((opts: { persona?: string; json?: boolean }) => {
    const path = resolvePersonaSourcePath(opts.persona);
    if (!opts.persona) noteInheritance(path);
    const goal = readGoalText(loadPersona(path));
    emit(
      [goal ? `  ${chalk.cyan("goal")}  ${goal}` : chalk.dim("  no standing goal set")],
      { specPath: path, goal: goal ?? null },
      !!opts.json,
    );
  });

export const reviewCommand = new Command("review")
  .description("Pending governed self-edits: list them, or approve/reject one by id")
  .argument("[decision]", "approve | reject (omit to list)")
  .argument("[id]", "Proposal id (or `all`)")
  .option("-p, --persona <path>", "Persona to act on (defaults to the one in scope)")
  .option("--json", "Emit machine-readable JSON")
  .action((decision: string | undefined, id: string | undefined, opts: { persona?: string; json?: boolean }) => {
    const path = resolvePersonaSourcePath(opts.persona);
    if (!opts.persona) noteInheritance(path);
    const pending = proposals(path).filter((p) => p.status === "pending");

    if (!decision) {
      emit(
        pending.length
          ? pending.map((p) => `  ${chalk.yellow(p.id.slice(0, 12))} ${chalk.cyan(p.targetPath)}  ${chalk.dim(String(p.rationale ?? "").slice(0, 60))}`)
          : [chalk.dim("  no pending self-edits")],
        { specPath: path, pending: pending.map((p) => ({ id: p.id, targetPath: p.targetPath, toValue: p.toValue, rationale: p.rationale })) },
        !!opts.json,
      );
      return;
    }
    if (decision !== "approve" && decision !== "reject") {
      console.error(chalk.red("Error:"), "decision must be `approve` or `reject`.");
      process.exit(1);
    }
    if (!id) {
      console.error(chalk.red("Error:"), "give a proposal id, or `all`.");
      process.exit(1);
    }
    const targets = id === "all" ? pending.map((p) => p.id) : [id];
    const done: Array<{ id: string; decision: string; ok: boolean; error?: string }> = [];
    for (const t of targets) {
      try {
        if (decision === "approve") applySelfEdit(path, t, "cli");
        else rejectSelfEdit(path, t, "cli");
        done.push({ id: t, decision, ok: true });
      } catch (e) {
        done.push({ id: t, decision, ok: false, error: (e as Error).message });
      }
    }
    const failed = done.filter((d) => !d.ok);
    emit(
      done.map((d) => (d.ok ? `  ${chalk.green("✓")} ${d.decision} ${d.id.slice(0, 12)}` : `  ${chalk.red("✗")} ${d.id.slice(0, 12)}: ${d.error}`)),
      { specPath: path, results: done },
      !!opts.json,
    );
    if (failed.length) process.exit(1);
  });

export const doctorCommand = new Command("doctor")
  .description("Offline health check: spec validity, lint, memory-chain integrity, model config, pending work")
  .option("-p, --persona <path>", "Persona to check (defaults to the one in scope)")
  .option("--net", "Also ping the configured provider (off by default: a health check touches no network unless asked)")
  .option("--json", "Emit machine-readable JSON")
  .action(async (opts: { persona?: string; net?: boolean; json?: boolean }) => {
    // The SAME checks the slash command runs: two health reports that disagree would be
    // worse than one.
    const doctorPath = resolvePersonaSourcePath(opts.persona);
    if (!opts.persona) noteInheritance(doctorPath);
    const report = await runDoctorChecks(doctorPath, opts.net ? "net" : "");
    emit(
      report.lines,
      { ok: report.failures === 0, failures: report.failures, warnings: report.warnings, lines: report.lines.map(strip) },
      !!opts.json,
    );
    if (report.failures > 0) process.exit(1);
  });
