/**
 * The Ledger, one place for all the evidence.
 *
 * /replay, /rewind and /audit used to be three commands over the same evidence, and the
 * difference between them was not obvious from their names. There is now ONE command,
 * `/audit`, with four tabs:
 *   Timeline    every mutation, with the rate chart; REWIND is an action here
 *   Integrity   the hash chain + REPLAY (rebuild the state from the log and compare)
 *   Self-edits  what the persona proposed to change about itself, and the verdict
 *   Evaluations the quality/utility scores it earned
 *
 * Each tab opens with a plain-language line saying what it proves, because evidence
 * nobody understands is not evidence.
 */

import chalk from "chalk";
import {
  record,
  readState,
  verifyMemoryChain,
  readMemory,
  proposals,
  readEvaluations,
  rebuildStateValues,
  extractEnvelopes,
} from "@personaxis/core";
import { rewind } from "../../rewind.js";
import { lineChart } from "@personaxis/tui/visual";
import type { Ctx } from "../types.js";
import type { TabLine, TabAction } from "./tabbed.js";

export const AUDIT_TABS = ["Timeline", "Integrity", "Self-edits", "Evaluations"] as const;

const row = (label: string, value: string): string => `  ${chalk.cyan(label.padEnd(14))} ${value}`;

/** Timeline: what changed, when, why, and how often. */
export function timelineLines(ctx: Ctx): TabLine[] {
  const st = readState(ctx.handle.statePath);
  const log = st.mutation_log ?? [];
  if (!log.length) {
    return [
      chalk.dim("  what this proves: every change to this persona's state is recorded, in order."),
      "",
      chalk.dim("  nothing has changed yet; the timeline fills as the persona lives."),
    ];
  }
  // Mutations per day over the last two weeks.
  const days = new Map<string, number>();
  let clamped = 0;
  let blocked = 0;
  const byField = new Map<string, number>();
  for (const m of log) {
    const day = String(m.ts ?? "").slice(0, 10);
    if (day) days.set(day, (days.get(day) ?? 0) + 1);
    if (m.clamped) clamped += 1;
    if ((m as { blocked?: boolean }).blocked) blocked += 1;
    byField.set(m.field, (byField.get(m.field) ?? 0) + 1);
  }
  const N = 14;
  const start = new Date();
  start.setDate(start.getDate() - (N - 1));
  const points = Array.from({ length: N }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return days.get(d.toISOString().slice(0, 10)) ?? 0;
  });
  const top = [...byField.entries()].sort((a, b) => b[1] - a[1])[0];

  return [
    chalk.dim("  what this proves: every change is recorded, in order, with who asked and why."),
    "",
    ...lineChart([{ label: "mutations/day", points, color: 6 }], { height: 5, xLabels: ["14d ago", "today"] }),
    "",
    row("total", `${log.length} mutation(s)`),
    row("clamped", `${clamped}` + (clamped ? chalk.dim("  (kept inside the declared envelope)") : "")),
    row("blocked", `${blocked}` + (blocked ? chalk.dim("  (refused by governance)") : "")),
    row("most moved", top ? `${top[0]} ${chalk.dim(`(${top[1]}x)`)}` : "-"),
    "",
    chalk.bold("  Recent"),
    ...log
      .slice(-10)
      .reverse()
      .map(
        (m) =>
          `  ${chalk.dim(String(m.ts ?? "").slice(0, 16).replace("T", " "))} ${m.field.padEnd(34)} ` +
          `${typeof m.from === "number" ? m.from.toFixed(3) : "?"} → ${typeof m.to === "number" ? m.to.toFixed(3) : "?"}` +
          `${m.clamped ? chalk.yellow(" clamped") : ""} ${chalk.dim(`[${m.actor ?? "?"}]`)}`,
      ),
    "",
    // V8.A: rewind is an ACTION here, not a pointer to a command that still exists.
    // This line used to say "use /rewind", which is how an absorbed verb quietly stayed
    // a verb: the capability has to move, or the consolidation is only cosmetic.
    {
      label: "rewind",
      value: chalk.dim(`${log.length} mutation(s) recorded`),
      hint: "Enter undoes the last N mutations · the undo is itself recorded, history is never rewritten",
      onEnter: async (): Promise<TabAction> => {
        if (!log.length) return { kind: "toast", text: "nothing to rewind" };
        if (!ctx.ask) return { kind: "toast", text: "outside a terminal, use: personaxis state rewind <n>" };
        const n = Math.max(0, Number((await ctx.ask("  undo how many mutations? ")).trim()) || 0);
        if (!n) return { kind: "toast", text: "cancelled" };
        const env = extractEnvelopes(ctx.handle.frontmatter);
        const { changed, steps } = await rewind(
          ctx.handle.personaPath,
          ctx.handle.statePath,
          readState(ctx.handle.statePath),
          env.envelopes,
          n,
          record.authorOf("human-operator"),
        );
        return {
          kind: "toast",
          text: changed.length
            ? `rewound ${steps} mutation(s) · restored ${changed.join(", ")}`
            : `rewind ${steps}: already at that point`,
        };
      },
    },
  ];
}

/**
 * Integrity: the two independent guarantees, verified live. This is what `/replay` used
 * to be: rebuilding the state from the log and comparing it against what is stored.
 */
export function integrityLines(ctx: Ctx): string[] {
  const p = ctx.handle.personaPath;
  const st = readState(ctx.handle.statePath);
  const chain = verifyMemoryChain(p);
  const entries = readMemory(p);
  const env = extractEnvelopes(ctx.handle.frontmatter);
  const lines: string[] = [
    chalk.dim("  what this proves: memory cannot be altered unnoticed (T5), and the state is exactly"),
    chalk.dim("  what its own log says it should be (T4). Both are re-derived right now, not cached."),
    "",
    chalk.bold("  Memory chain"),
    row("status", chain.ok ? chalk.green("intact ✓") : chalk.red(`BROKEN at entry #${chain.brokenAt}`)),
    row("entries", String(entries.length)),
  ];
  if (!chain.ok) {
    lines.push(chalk.red("  a broken link means an entry was edited after it was written; the position above is the spot."));
  }

  // Replay: fold the mutation log and compare with the stored values. This is what the
  // old `/replay` command did; `rebuildStateValues` already reports the disagreements.
  lines.push("", chalk.bold("  Replay (state as a fold of its log)"));
  try {
    const { drift } = rebuildStateValues(env.envelopes, st.mutation_log ?? [], st.values);
    if (!drift.length) {
      lines.push(row("verdict", chalk.green("reproduces exactly ✓")));
      lines.push(
        chalk.dim(`  replayed ${(st.mutation_log ?? []).length} entr(ies); no stored value exists that the log cannot explain.`),
      );
    } else {
      lines.push(row("verdict", chalk.red(`${drift.length} unexplained value(s)`)));
      for (const d of drift) {
        lines.push(
          `  ${chalk.red("✗")} ${d.field}: log says ${d.rebuilt.toFixed(3)}, state holds ${d.stored === undefined ? "nothing" : d.stored.toFixed(3)}`,
        );
      }
      lines.push(chalk.dim("  a mismatch means a value was written without an audited entry (T4 catches it)."));
    }
  } catch (e) {
    lines.push(chalk.yellow(`  replay unavailable: ${(e as Error).message}`));
  }
  return lines;
}

/** Self-edits: what the persona wanted to change about itself, and the verdict. */
export function selfEditLines(ctx: Ctx): string[] {
  const all = proposals(ctx.handle.personaPath);
  if (!all.length) {
    return [
      chalk.dim("  what this proves: the persona cannot rewrite itself silently; every attempt is queued here."),
      "",
      chalk.dim("  no self-edits yet."),
    ];
  }
  const pending = all.filter((x) => x.status === "pending");
  return [
    chalk.dim("  what this proves: the persona cannot rewrite itself silently; every attempt is recorded"),
    chalk.dim("  with its governance verdict, whatever the improve mode."),
    "",
    row("total", String(all.length)),
    row("pending", pending.length ? chalk.yellow(`${pending.length} · decide them in /persona → Evolution`) : "0"),
    "",
    chalk.bold("  Recent"),
    ...all
      .slice(-10)
      .reverse()
      .map((x) => {
        const c = x.status === "applied" ? chalk.green : x.status === "pending" ? chalk.yellow : chalk.red;
        return `  ${chalk.dim(x.id.slice(0, 12))} ${c(x.status.padEnd(9))} ${chalk.dim(x.targetPath)}`;
      }),
  ];
}

/** Evaluations: the scores this persona earned, with the reason. */
export function evaluationLines(ctx: Ctx): string[] {
  const evals = readEvaluations(ctx.handle.personaPath);
  if (!evals.length) {
    return [
      chalk.dim("  what this proves: quality is measured, not asserted."),
      "",
      chalk.dim("  no evaluations recorded yet."),
    ];
  }
  const avg = evals.reduce((n, e) => n + e.score, 0) / evals.length;
  return [
    chalk.dim("  what this proves: quality is measured, not asserted; each score carries its reason."),
    "",
    row("recorded", String(evals.length)),
    row("average", avg.toFixed(2)),
    "",
    chalk.bold("  Recent"),
    ...evals
      .slice(-10)
      .reverse()
      .map((ev) => {
        const c = ev.score >= 0.66 ? chalk.green : ev.score >= 0.33 ? chalk.yellow : chalk.red;
        return `  ${chalk.dim(ev.target.padEnd(20))} ${ev.dimension.padEnd(12)} ${c(ev.score.toFixed(2))}  ${chalk.dim(ev.rationale)}`;
      }),
  ];
}

export function auditLines(ctx: Ctx, tab: number): TabLine[] {
  switch (tab) {
    case 1:
      return integrityLines(ctx);
    case 2:
      return selfEditLines(ctx);
    case 3:
      return evaluationLines(ctx);
    default:
      return timelineLines(ctx);
  }
}
