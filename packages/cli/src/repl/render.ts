/**
 * Terminal rendering for the REPL: the personaxis wordmark, a per-persona sigil,
 * and event formatting. The engine emits data; this is the only place that paints.
 */

import chalk from "chalk";
import {
  renderSigil,
  sigilParams,
  liveIntensity,
  type LoopEvent,
  type PersonaFrontmatter,
} from "@personaxis/core";

export const LOGO = [
  "  ___  ___ _ __ ___  ___  _ __   __ ___  _____ ____ ",
  " / _ \\/ _ \\ '__/ __|/ _ \\| '_ \\ / _` \\ \\/ /_ _/ ___|",
  "|  __/  __/ |  \\__ \\ (_) | | | | (_| |>  < | |\\___ \\",
  " \\___|\\___|_|  |___/\\___/|_| |_|\\__,_/_/\\_\\___|____/",
];

export function banner(): string {
  const l = chalk.bold.magentaBright;
  return (
    "\n" +
    LOGO.map((row) => l(row)).join("\n") +
    "\n" +
    chalk.dim("  living, governed personas · type ") +
    chalk.cyan("/help") +
    chalk.dim(" · ") +
    chalk.cyan("/exit") +
    chalk.dim(" to leave") +
    "\n"
  );
}

/** Render a persona's sigil, colored by its own identity, breathing with state. */
export function sigilBlock(
  frontmatter: PersonaFrontmatter,
  values: Record<string, number>,
  frame = 0,
): string {
  const params = sigilParams(frontmatter);
  const sigil = renderSigil(params, liveIntensity(values, frame));
  const paint = chalk.ansi256(params.color);
  return sigil.grid.map((row) => "   " + paint(row)).join("\n");
}

/** A one-line mood gauge for the prompt. */
export function moodGauge(values: Record<string, number>): string {
  const tone = values["mood.tone"] ?? 0;
  const ticks = 9;
  const pos = Math.round(((tone + 1) / 2) * (ticks - 1));
  let bar = "";
  for (let i = 0; i < ticks; i++) bar += i === pos ? "●" : "·";
  const color = tone > 0.15 ? chalk.green : tone < -0.15 ? chalk.red : chalk.yellow;
  return color(bar);
}

export function formatEvent(e: LoopEvent): string | null {
  switch (e.type) {
    case "observe":
      return chalk.dim(`  ◌ observe  [${e.source}] ${truncate(e.observation, 70)}`);
    case "appraise":
      return chalk.dim(`  ◍ appraise  ${truncate(e.signal.appraisal, 70)} `) +
        chalk.dim(`(conf ${e.signal.confidence.toFixed(2)})`);
    case "govern": {
      const ok = e.verdicts.filter((v) => v.admitted).length;
      const no = e.verdicts.length - ok;
      return chalk.dim(`  ⚖ govern   ${ok} admitted, ${no} rejected`);
    }
    case "mutate": {
      const r = e.result;
      const arrow = `${r.from.toFixed(3)} → ${r.to.toFixed(3)}`;
      const flags =
        (r.clamped ? chalk.yellow(" clamped") : "") +
        (r.blocked ? chalk.red(" blocked") : "");
      return `  ✦ ${chalk.bold(r.entry.field)}  ${arrow}${flags}`;
    }
    case "memory":
      return chalk.cyan(`  ✎ memory   [${e.entry.source}] ${truncate(e.entry.content, 60)} `) +
        chalk.dim(`#${e.entry.hash.slice(0, 8)}`);
    case "anomaly":
      return chalk.red(`  ⚠ anomaly   ${e.kind}: ${e.detail}`);
    case "recompile":
      return chalk.magenta(`  ↻ recompile  ${e.reason}`);
    case "abstain":
      return chalk.yellow(`  ⊘ abstain   ${e.reason}`);
    case "error":
      return chalk.red(`  ✗ error     ${e.message}`);
    case "tick-complete":
      return chalk.dim(
        `  ─ tick done · ${e.mutationsApplied} mutation(s), ${e.memoriesWritten} memory write(s)`,
      );
    default:
      return null;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
