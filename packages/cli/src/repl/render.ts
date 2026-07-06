/**
 * REPL rendering helpers (F3.6 split).
 *
 * Pure display: loop/agent events → a display line, the spinner phase label,
 * the persona reply line + sigil glyph, and small formatters. No side effects
 * beyond building strings.
 */

import chalk from "chalk";
import { eventLine } from "@personaxis/tui/visual";
import type { PersonaTheme } from "@personaxis/core";
import type { Ctx, LoopEvent } from "./types.js";

export function phaseFor(e: LoopEvent): string {
  switch (e.type) {
    case "agent-step": return "thinking";
    case "tool-propose": return `running ${e.tool}`;
    case "tool-result": return "reading result";
    case "verify-start":
    case "verify-result": return "verifying";
    case "appraise": return "appraising";
    case "context-compacted": return "compacting context";
    default: return "working";
  }
}

/** Render any loop OR agent event into a single display line (or null to skip). */
export function renderEvent(theme: PersonaTheme, e: LoopEvent): string | null {
  switch (e.type) {
    // Internal agent reasoning is NOT shown — the reply is printed once by the
    // caller. Only real ACTIONS (tool calls) and errors surface as activity.
    case "abstain":
    case "agent-step":
    case "agent-think":
    case "agent-finish":
      return null;
    case "tool-propose":
      return chalk.cyan(`  → ${e.tool} ${chalk.dim(JSON.stringify(e.args).slice(0, 80))}`);
    case "tool-verdict": {
      const c = e.decision === "deny" ? chalk.red : e.decision === "ask" ? chalk.yellow : chalk.green;
      return `    ${c(e.decision)} ${chalk.dim(e.reason)}`;
    }
    case "tool-result":
      return chalk.dim(`    ${e.ok ? "✓" : "✗"} ${e.output.split("\n")[0].slice(0, 90)}`);
    case "agent-error":
      return chalk.red(`  └─ agent error: ${e.message}`);
    case "agent-stop-condition":
      return chalk.yellow(`  ■ stop: ${e.reason} (step ${e.step})`);
    case "verify-start":
      return chalk.dim(`  verify · ${e.gates} gate${e.gates === 1 ? "" : "s"}…`);
    case "verify-result":
      return `  verify   ${e.pass ? chalk.green("pass") : chalk.red("fail")} ${chalk.dim(`${e.verifier}: ${e.reason}`)}`;
    case "verify-complete":
      return e.passed ? chalk.green(`  verify · ok (${e.passes}/${e.quorum})`) : chalk.red(`  verify · FAILED (${e.passes}/${e.quorum})`);
    case "agent-budget":
    case "context-meter":
    case "memory-recall":
    case "evaluation":
      return null; // surfaced in the concise per-turn summary (not inline noise) / status bar
    case "context-compacted":
      return chalk.dim(`  · context compacted (${e.removed} msgs freed)`);
    default:
      return eventLine(theme, e);
  }
}

export function shortName(ctx: Ctx): string {
  const id = ctx.handle.frontmatter.identity as { short_name?: string; display_name?: string; canonical_id?: string } | undefined;
  const pick = id?.short_name?.trim() || id?.display_name?.trim() || id?.canonical_id?.trim() || "persona";
  return pick.length <= 32 ? pick : pick.slice(0, 31) + "…";
}

/** A small, stable per-persona sigil glyph (a mid-density char from its themed set). */
export function personaGlyph(ctx: Ctx): string {
  const g = ctx.theme.glyphs;
  return g[Math.min(4, g.length - 1)] ?? "◇";
}

/**
 * Format a persona's reply line. The ROOT persona speaks in the terminal's default
 * foreground so it reads as "the" voice; a sub-persona (ctx.replyColor set) gets its
 * own FIXED color. A small per-persona sigil glyph prefixes the name.
 */
export function replyLine(ctx: Ctx, text: string): string {
  const glyph = personaGlyph(ctx);
  const name = shortName(ctx);
  if (ctx.replyColor !== undefined) {
    const c = chalk.ansi256(ctx.replyColor);
    return `${c.dim(glyph)} ${c.bold.underline(name)} ${c.dim("›")}  ${c(text)}`;
  }
  return `${chalk.dim(glyph)} ${chalk.bold.underline(name)} ${chalk.dim("›")}  ${text}`;
}

export function fmtK(n: number): string {
  return n >= 1000 ? (n / 1000).toFixed(1) + "K" : String(n);
}

export function firstRunModelHint(out: (s: string) => void): void {
  out(chalk.yellow("  No model configured — running in offline heuristic mode (no real reasoning)."));
  out(chalk.dim("  Configure ONCE (global, all projects):"));
  out(chalk.dim("    personaxis config set --global local.endpoint <openai-compatible-url>"));
  out(chalk.dim("    personaxis config set --global local.model <model-name>"));
  out(chalk.dim("    personaxis config set --global local.apiKeyEnv <ENV_VAR_WITH_YOUR_KEY>"));
  out(chalk.dim("  …or in-session: /model set endpoint <url> · /model set model <name> · /model set key-env <ENV> global"));
}
