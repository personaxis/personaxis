/**
 * The single visual engine for personaxis.
 *
 * One place for ALL terminal visuals, the animated wordmark, a persona's
 * "awakening", its themed + animated sigil, the live aura, per-event flourishes,
 * and voice-styled output. Everything is driven by the persona's PersonaTheme, so
 * each persona looks AND behaves differently in the terminal. Reused by both the
 * REPL (@personaxis/cli) and the dashboard (this package).
 *
 * Animations only play on a real TTY; piped/CI output prints the final frame once.
 */

import chalk from "chalk";
import {
  personaTheme,
  renderThemedSigil,
  themeIntensity,
  barIndex,
  displayName,
  sigilParams,
  liveIntensity,
  type PersonaTheme,
  type PersonaFrontmatter,
  type StateFile,
  type LoopEvent,
} from "@personaxis/core";
import { auraLines } from "./aura.js";

export { auraRows, auraLines, auraFeatures, auraPalette, auraSpaceSize, AURA_WIDTH, type AuraState } from "./aura.js";
export { lineChart, heatmapGitHub, type LineSeries } from "./charts.js";

export const supportsAnim = (): boolean =>
  Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && process.env.PERSONAXIS_NO_ANIM !== "1";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const write = (s: string): void => void process.stdout.write(s);

// A robust 5-row block font (only █ and space → renders identically in every
// monospace terminal; no slant/underscore tricks that collapsed into "eersonaxis").
const FONT: Record<string, string[]> = {
  p: ["█████", "█   █", "█████", "█    ", "█    "],
  e: ["█████", "█    ", "███  ", "█    ", "█████"],
  r: ["█████", "█   █", "█████", "█  █ ", "█   █"],
  s: ["█████", "█    ", "█████", "    █", "█████"],
  o: ["█████", "█   █", "█   █", "█   █", "█████"],
  n: ["█   █", "██  █", "█ █ █", "█  ██", "█   █"],
  a: ["█████", "█   █", "█████", "█   █", "█   █"],
  x: ["█   █", " █ █ ", "  █  ", " █ █ ", "█   █"],
  i: ["█████", "  █  ", "  █  ", "  █  ", "█████"],
};

/** Compose a word from FONT, row by row. Letters it doesn't know become spaces. */
export function renderWordmark(word: string): string[] {
  const rows = ["", "", "", "", ""];
  for (const ch of word.toLowerCase()) {
    const g = FONT[ch] ?? ["     ", "     ", "     ", "     ", "     "];
    for (let r = 0; r < 5; r++) rows[r] += g[r] + " ";
  }
  return rows;
}

// The brand mark: the personaxis STICKMAN (the real logo), small and alive.
const EMBLEM = [
  "   ◉   ",
  "  /│\\  ",
  "   │   ",
  "  / \\  ",
];

export const LOGO = renderWordmark("personaxis");

// Monochrome: the terminal's DEFAULT foreground (bold) adapts to light/dark themes
// automatically, dark on a light terminal, light on a dark one. No color.
const TAGLINE = chalk.dim("  the home of living, governed AI personas · ") + chalk.bold("/help");
const word = (l: string): string => chalk.bold(l);

/** Paint the emblem; `bright` controls the core (used for a single subtle pulse). */
function paintEmblem(bright: boolean): string {
  const core = "◉";
  return EMBLEM.map((line) => {
    let out = "";
    for (const ch of line) {
      if (ch === core) out += bright ? chalk.bold(ch) : chalk.dim(ch);
      else if (ch === " ") out += " ";
      else out += chalk.dim(ch);
    }
    return out;
  }).join("\n");
}

/** Compact single-line logo for narrow terminals (the block wordmark would wrap + break). */
function compactLogo(): string {
  return chalk.bold("◉ personaxis") + chalk.dim("  ·  living, governed AI personas");
}

/**
 * A quiet, premium reveal. V5.P3.1 ROOT-CAUSE FIX: the old animation repainted in
 * place with raw `\x1b[s`/`\x1b[u` cursor save/restore, which many terminals
 * (Windows Terminal, tmux) do not honor reliably: every frame then printed BELOW
 * the last one, cascading the emblem and half-built wordmark down the screen.
 * The reveal is now strictly append-only (each line is printed exactly once, top
 * to bottom, with a small delay): it cannot corrupt on ANY terminal, and the
 * final scrollback is identical to the static render. Responsive: a one-line
 * mark when the terminal is narrower than the block.
 */
export async function animateLogo(): Promise<void> {
  // The BLOCK WORDMARK is the logo and it stays. V7.E5 replaced it with a single
  // line of text on the grounds that it was a billboard; what had actually been
  // asked for was removing the STICKMAN emblem above it, not the wordmark, and the
  // startup lost its identity in the process. The emblem stays commented out; the
  // wordmark comes back, with the one-line mark kept for terminals too narrow to
  // hold it (where the block would wrap and shred itself).
  const oneLine = chalk.bold("personaxis") + chalk.dim("  ·  living, governed AI personas") + chalk.dim("  ·  /help");
  const cols = process.stdout.columns ?? 80;
  const wordmarkWidth = Math.max(...LOGO.map((l) => l.length));

  if (cols < wordmarkWidth + 2) {
    write("\n" + oneLine + "\n\n");
    return;
  }
  if (!supportsAnim()) {
    write("\n" + LOGO.map(word).join("\n") + "\n" + TAGLINE + "\n\n");
    return;
  }
  // Append-only reveal, one row at a time, top to bottom: it cannot corrupt on any
  // terminal (the old cursor save/restore version cascaded on Windows Terminal).
  write("\n");
  for (const line of LOGO) {
    write(word(line) + "\n");
    await sleep(45);
  }
  await sleep(60);
  write(TAGLINE + "\n\n");
}

function paintGlyphRow(theme: PersonaTheme, row: string): string {
  const { primary, secondary, accent } = theme.palette;
  let out = "";
  for (const ch of row) {
    const idx = theme.glyphs.indexOf(ch);
    if (ch === " " || idx <= 0) out += " ";
    else if (idx <= 2) out += chalk.ansi256(secondary)(ch);
    else if (idx <= 4) out += chalk.ansi256(primary)(ch);
    else out += chalk.ansi256(accent).bold(ch);
  }
  return out;
}

/** Colored, themed sigil for one frame. */
export function sigilLines(theme: PersonaTheme, values: Record<string, number>, frame = 0): string[] {
  const sig = renderThemedSigil(theme, values, frame);
  return sig.grid.map((row) => "     " + paintGlyphRow(theme, row));
}

/**
 * The persona materializing (V5.P3.2): the AURA, its living creature form,
 * unique per persona (seeded features), colored by its theme. Append-only
 * reveal (line by line, printed once): the old center-out repaint used
 * `\x1b[s`/`\x1b[u` and cascaded on terminals that ignore cursor save/restore,
 * the same root cause as the banner bug.
 */
export async function awaken(fm: PersonaFrontmatter, state: StateFile): Promise<void> {
  const theme = personaTheme(fm);
  const name = displayName(fm);
  const params = sigilParams(fm);
  const intensity = liveIntensity(state.values, 0);
  write("  " + chalk.bold.ansi256(theme.palette.accent)(name) + chalk.dim(`  ·  aura #${theme.seed.toString(16)} (its unique living mark)\n\n`));
  const lines = auraLines(params, 0, { intensity }).split("\n").map((l) => "     " + l);
  if (!supportsAnim()) {
    write(lines.join("\n") + "\n\n");
    return;
  }
  for (const line of lines) {
    write(line + "\n");
    await sleep(50);
  }
  write("\n");
}

/** A colored aura/mood gauge for the prompt + dashboard. */
export function auraBar(theme: PersonaTheme, values: Record<string, number>, frame = 0): string {
  const intensity = themeIntensity(theme, values, frame);
  const ticks = 11;
  const lit = Math.round(intensity * (ticks - 1));
  let bar = "";
  for (let i = 0; i < ticks; i++) {
    bar += i <= lit ? chalk.ansi256(theme.palette.primary)("◈") : chalk.ansi256(theme.palette.dim)("·");
  }
  return bar;
}

/** One envelope row; `selected` renders the drill-down cursor (F6.7b). */
export function envelopeRow(
  theme: PersonaTheme,
  key: string,
  value: number,
  e: { min: number; max: number },
  width = 18,
  selected = false,
): string {
  const pos = barIndex(value, { ...e, mean: 0 }, width);
  let bar = "";
  for (let i = 0; i < width; i++) bar += i === pos ? chalk.ansi256(theme.palette.accent)("◉") : chalk.ansi256(theme.palette.dim)("─");
  const label = selected ? chalk.ansi256(theme.palette.accent).bold(key.padEnd(28)) : key.padEnd(28);
  return `${selected ? chalk.ansi256(theme.palette.accent)("▸ ") : "  "}${label} ${bar} ${chalk.dim(value.toFixed(2))}`;
}

/** Envelope bars colored in the persona's palette. */
export function envelopeBars(
  theme: PersonaTheme,
  values: Record<string, number>,
  envelopes: Record<string, { min: number; max: number }>,
  width = 18,
): string {
  const rows: string[] = [];
  for (const [k, v] of Object.entries(values)) {
    const e = envelopes[k];
    if (!e) continue;
    rows.push(envelopeRow(theme, k, v, e, width));
  }
  return rows.join("\n");
}

const SPARK = "▁▂▃▄▅▆▇█";

/** Compact drift gauge for status lines and headers (FASE 7 P2). Pure string
 *  builder over a DriftReport-shaped input; the caller owns the data. */
export function driftGauge(
  theme: PersonaTheme,
  report: { global: number; layers: Array<{ layer: string; drift: number; threshold?: number; exceeded: boolean }> },
  width = 10,
): string {
  const filled = Math.round(Math.min(1, report.global) * width);
  const over = report.layers.filter((l) => l.exceeded);
  const bar =
    chalk.ansi256(over.length ? 196 : theme.palette.accent)("▰".repeat(filled)) +
    chalk.ansi256(theme.palette.dim)("▱".repeat(width - filled));
  const tail = over.length
    ? chalk.red(` ⚠${over.map((l) => l.layer).join(",")}`)
    : "";
  return `D ${bar} ${report.global.toFixed(2)}${tail}`;
}

/** Pure sparkline over a series, scaled to [min,max] (the coordinate's envelope). */
export function sparkline(series: number[], min: number, max: number, width = 32): string {
  if (series.length === 0) return "";
  const pts = series.slice(-width);
  const span = max - min || 1;
  return pts
    .map((v) => SPARK[Math.max(0, Math.min(SPARK.length - 1, Math.round(((v - min) / span) * (SPARK.length - 1))))])
    .join("");
}

/** Per-event flourish, themed glyphs + color, distinct per event kind. */
export function eventLine(theme: PersonaTheme, e: LoopEvent): string | null {
  const p = (n: number) => chalk.ansi256(n);
  const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  switch (e.type) {
    case "observe":
      return chalk.dim(`  ◌ observe  [${e.source}] ${trunc(e.observation, 66)}`);
    case "appraise":
      return p(theme.palette.secondary)(`  ◍ appraise `) + chalk.dim(`${trunc(e.signal.appraisal, 60)} (conf ${e.signal.confidence.toFixed(2)})`);
    case "govern": {
      const ok = e.verdicts.filter((v) => v.admitted).length;
      return chalk.dim(`  ◇ govern   ${ok} admitted, ${e.verdicts.length - ok} rejected`);
    }
    case "mutate": {
      const r = e.result;
      const ripple = p(theme.palette.accent)("◦○◉○◦");
      return `  ${ripple} ${chalk.bold(r.entry.field)} ${r.from.toFixed(3)}→${r.to.toFixed(3)}` +
        (r.clamped ? chalk.yellow(" clamped") : "") + (r.blocked ? chalk.red(" blocked") : "");
    }
    case "memory":
      return p(theme.palette.primary)(`  ✶ memory  `) + chalk.dim(`[${e.entry.source}] ${trunc(e.entry.content, 52)} #${e.entry.hash.slice(0, 8)}`);
    case "anomaly":
      return chalk.bgRed.whiteBright(` ! ${e.kind} `) + chalk.red(` ${e.detail}`);
    case "recompile":
      return p(theme.palette.secondary)(`  ↻ live-sync  ${e.reason}`);
    case "abstain":
      return chalk.yellow(`  ⊘ abstain  ${e.reason}`);
    case "error":
      return chalk.red(`  ✗ ${e.message}`);
    case "tick-complete":
      return chalk.dim(`  ─ ${e.mutationsApplied} mutation(s), ${e.memoriesWritten} memory write(s)`);
    default:
      return null;
  }
}

/** Style a line of output to the persona's voice. */
export function voiceWrap(theme: PersonaTheme, text: string): string {
  switch (theme.voice.density) {
    case "terse":
      return chalk.ansi256(theme.palette.dim)(text);
    case "expansive":
      return chalk.ansi256(theme.palette.accent)("◇ ") + chalk.ansi256(theme.palette.primary)(text);
    default:
      return chalk.ansi256(theme.palette.primary)(text);
  }
}

export async function farewell(fm: PersonaFrontmatter): Promise<void> {
  const theme = personaTheme(fm);
  write("\n" + chalk.ansi256(theme.palette.dim)("  persona sleeping. state + memory persisted.") + "\n");
}

/** Loop a renderer for `frames` at `interval`ms (TTY only), clearing each frame. */
export async function play(render: (frame: number) => string, frames: number, interval: number): Promise<void> {
  if (!supportsAnim()) {
    write(render(0) + "\n");
    return;
  }
  for (let f = 0; f < frames; f++) {
    write("\x1b[2J\x1b[H" + render(f));
    await sleep(interval);
  }
}
