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
    // Internal agent reasoning is NOT shown, the reply is printed once by the
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
      return chalk.red(`  └─ agent error: ${friendlyProviderError(e.message)}`);
    case "agent-stop-condition":
      return chalk.yellow(`  ■ stop: ${e.reason} (step ${e.step})`);
    // Verification stays VISIBLE by design (it is evidence, not noise); V3.2 only
    // upgrades its presentation: a shield badge, per-gate marks, a closing verdict.
    case "verify-start":
      return chalk.dim(`  ⛨ verify · running ${e.gates} gate${e.gates === 1 ? "" : "s"}…`);
    case "verify-result":
      return `    ${e.pass ? chalk.green("✓") : chalk.red("✗")} ${chalk.bold(e.verifier)} ${chalk.dim(e.reason)}`;
    case "verify-complete":
      return e.passed
        ? chalk.green(`  ⛨ verify ok`) + chalk.dim(` (${e.passes}/${e.quorum} gates)`)
        : chalk.bgRed.whiteBright(` ⛨ verify FAILED `) + chalk.red(` ${e.passes}/${e.quorum} gates passed`);
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
/**
 * The persona's speech mark. It used to take a glyph from the theme's charset, which
 * includes ASCII fill characters: a persona whose set landed on `#` prefixed every reply
 * with `# Name ›`, and in monochrome that reads as a Markdown heading. The mark is now
 * chosen from a small set of shapes that can only ever look like a mark, indexed by the
 * persona's own seed so it stays personal.
 */
const SPEECH_MARKS = ["◆", "◇", "●", "○", "▰", "▱", "◈", "❖", "✦", "⬟", "⬢", "◉"] as const;

export function personaGlyph(ctx: Ctx): string {
  return SPEECH_MARKS[(ctx.theme.seed >>> 3) % SPEECH_MARKS.length];
}

/**
 * Format a persona's reply line. The ROOT persona speaks in the terminal's default
 * foreground so it reads as "the" voice; a sub-persona (ctx.replyColor set) gets its
 * own FIXED color. A small per-persona sigil glyph prefixes the name.
 */
/** Style inline markdown (code, bold, italic) for the terminal. ANSI-safe: the
 *  escape codes chalk inserts contain no `*`/backtick, so later passes never
 *  re-match them. With color disabled the markers are simply stripped. */
export function renderInlineMarkdown(s: string): string {
  return s
    .replace(/`([^`]+)`/g, (_m, c) => chalk.cyan(c))
    .replace(/\*\*([^*]+)\*\*/g, (_m, c) => chalk.bold(c))
    .replace(/(?<![*\w])\*([^*\n]+)\*(?!\w)/g, (_m, c) => chalk.italic(c))
    .replace(/(?<![_\w])_([^_\n]+)_(?!\w)/g, (_m, c) => chalk.italic(c));
}

/** Render a markdown string to terminal text: headers, bullet/numbered lists,
 *  fenced code blocks, and inline styling. Deterministic and side-effect-free. */
export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let inFence = false;
  for (const raw of lines) {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      continue; // drop the fence markers themselves
    }
    if (inFence) {
      out.push(chalk.dim("  │ " + raw));
      continue;
    }
    const h = raw.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      out.push(chalk.bold.underline(renderInlineMarkdown(h[2])));
      continue;
    }
    const b = raw.match(/^(\s*)[-*+]\s+(.*)$/);
    if (b) {
      out.push(`${b[1]}${chalk.dim("•")} ${renderInlineMarkdown(b[2])}`);
      continue;
    }
    const n = raw.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (n) {
      out.push(`${n[1]}${chalk.dim(n[2] + ".")} ${renderInlineMarkdown(n[3])}`);
      continue;
    }
    out.push(renderInlineMarkdown(raw));
  }
  return out.join("\n");
}

export function replyLine(ctx: Ctx, text: string): string {
  const glyph = personaGlyph(ctx);
  const name = shortName(ctx);
  const c = ctx.replyColor !== undefined ? chalk.ansi256(ctx.replyColor) : chalk;
  const prefix = `${c.dim(glyph)} ${c.bold.underline(name)} ${c.dim("›")}  `;
  const [first = "", ...rest] = renderMarkdown(text).split("\n");
  // Hanging indent so multi-line / markdown replies stay visually attached.
  return [prefix + first, ...rest.map((l) => "  " + l)].join("\n");
}

/**
 * YOUR line in the transcript: the user's own messages carry a distinct background so
 * they are told apart from the persona's replies at a glance.
 *
 * A subtle filled band, not the old bright block: a colored left rule marks the turn, the
 * text sits on a low-contrast background that reads as "this is the user" on both light
 * and dark terminals, and the fill stops with the text instead of stretching the row.
 * Under NO_COLOR the rule alone carries the distinction.
 */
export function userLine(text: string): string {
  const rule = chalk.cyan("▌");
  const body = chalk.bgAnsi256(236).whiteBright(` ${text} `);
  return `${rule}${body}`;
}

export function fmtK(n: number): string {
  return n >= 1000 ? (n / 1000).toFixed(1) + "K" : String(n);
}

/**
 * V5.FIX.2: translate raw provider failures into ACTIONABLE lines, whatever the
 * provider or mode (API key, local server, rate limit). The raw tail stays,
 * dimmed, for debugging; the first thing the user reads is what to DO.
 */
export function friendlyProviderError(message: string): string {
  const raw = chalk.dim(`  · raw: ${message.slice(0, 90)}`);
  if (/HTTP 40[13]|no api key|invalid[ _-]?(api[ _-]?)?key|unauthorized|forbidden/i.test(message)) {
    return `the provider rejected the credentials. Fix: /model picks a working profile · personaxis model set key <KEY> sets one · local servers (Ollama/LM Studio) need no key.\n${raw}`;
  }
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|ETIMEDOUT/i.test(message)) {
    return `the model endpoint is unreachable. If it is local (Ollama/LM Studio), start the server; otherwise review the endpoint with /model.\n${raw}`;
  }
  if (/HTTP 429|rate.?limit/i.test(message)) {
    return `the provider rate-limited this session (HTTP 429): wait a moment or switch profiles with /model.\n${raw}`;
  }
  if (/HTTP 404/.test(message)) {
    return `the endpoint answered 404: the model name or endpoint path is wrong for this provider (/model to review).\n${raw}`;
  }
  return message;
}

/** A tiny meter bar (V5.P1.2: shared by /context, /usage and the Settings view). */
export function meterBar(pct: number, w = 16): string {
  const filled = Math.round(Math.max(0, Math.min(1, pct)) * w);
  const color = pct >= 0.8 ? chalk.yellow : chalk.cyan;
  return color("▰".repeat(filled)) + chalk.dim("▱".repeat(w - filled));
}

const ANSI_RE = /\u001b\[[0-9;]*m/g;

/** Visible width of a possibly ANSI-styled string. */
export function visibleWidth(s: string): number {
  return s.replace(ANSI_RE, "").length;
}

/**
 * A titled panel with light box-drawing chrome (V3.2). Left-rail style, no right
 * border: ANSI-styled rows never need width-aware padding and long rows wrap
 * without breaking the frame. Pure string, so it renders identically in the Ink
 * transcript and the non-TTY line mode.
 */
export function panel(title: string, lines: string[], width = process.stdout.columns ?? 80): string {
  const w = Math.max(24, Math.min(width - 2, 100));
  const head = `  ${chalk.dim("╭─")} ${chalk.bold(title)} ${chalk.dim("─".repeat(Math.max(1, w - visibleWidth(title) - 7)))}`;
  const rail = lines.map((l) => `  ${chalk.dim("│")}${l.startsWith("  ") ? l.slice(1) : ` ${l}`}`);
  const foot = `  ${chalk.dim(`╰${"─".repeat(Math.max(1, w - 3))}`)}`;
  return [head, ...rail, foot].join("\n");
}

export function firstRunModelHint(out: (s: string) => void): void {
  out(chalk.yellow("  No model configured, running in offline heuristic mode (no real reasoning)."));
  out(chalk.dim("  Configure ONCE (global, all projects):"));
  out(chalk.dim("    personaxis config set --global local.endpoint <openai-compatible-url>"));
  out(chalk.dim("    personaxis config set --global local.model <model-name>"));
  out(chalk.dim("    personaxis config set --global local.apiKeyEnv <ENV_VAR_WITH_YOUR_KEY>"));
  out(chalk.dim("  …or in-session: /config (guided) · /model set endpoint <url> · /model set model <name> · /model set key-env <ENV>"));
}
