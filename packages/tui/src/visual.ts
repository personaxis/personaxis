/**
 * The single visual engine for personaxis (plan/09-ascii-ux).
 *
 * One place for ALL terminal visuals — the animated wordmark, a persona's
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
  type PersonaTheme,
  type PersonaFrontmatter,
  type StateFile,
  type LoopEvent,
} from "@personaxis/core";

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

// The brand mark from logo.svg: a radiating sun/sigil with a bright core.
const EMBLEM = [
  "      ·  ✶  ·      ",
  "    ╲   ╲│╱   ╱    ",
  "   ✶ ──  ◉  ── ✶   ",
  "    ╱   ╱│╲   ╲    ",
  "      ·  ✶  ·      ",
];

export const LOGO = renderWordmark("personaxis");

// Monochrome: the terminal's DEFAULT foreground (bold) adapts to light/dark themes
// automatically — dark on a light terminal, light on a dark one. No color.
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

/** A quiet, premium reveal: the emblem settles, the wordmark wipes in once. Monochrome.
 *  Responsive: falls back to a one-line mark when the terminal is narrower than the block. */
export async function animateLogo(): Promise<void> {
  const cols = process.stdout.columns ?? 80;
  if (cols < LOGO[0].length + 2) {
    write("\n" + compactLogo() + "\n\n");
    return;
  }
  if (!supportsAnim()) {
    write("\n" + paintEmblem(true) + "\n\n" + LOGO.map(word).join("\n") + "\n" + TAGLINE + "\n\n");
    return;
  }
  write("\n");
  // Emblem: a single gentle pulse on the core (dim → bright), not a loop.
  for (const bright of [false, true]) {
    write("\x1b[s" + paintEmblem(bright) + "\x1b[u");
    await sleep(120);
  }
  write(paintEmblem(true) + "\n\n");
  // Wordmark: left-to-right wipe, revealed once, then static.
  const width = LOGO[0].length;
  for (let w = 4; w <= width; w += 4) {
    write(`\x1b[s`);
    for (const line of LOGO) write("\x1b[2K" + word(line.slice(0, w)) + "\n");
    write("\x1b[u");
    await sleep(28);
  }
  for (const line of LOGO) write("\x1b[2K" + word(line) + "\n");
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

/** The persona materializing — sparse → full over a few frames. */
export async function awaken(fm: PersonaFrontmatter, state: StateFile): Promise<void> {
  const theme = personaTheme(fm);
  const name = displayName(fm);
  write("  " + chalk.bold.ansi256(theme.palette.accent)(name) + chalk.dim(`  ·  sigil #${theme.seed.toString(16)}\n\n`));
  const lines = sigilLines(theme, state.values, 0);
  if (!supportsAnim()) {
    write(lines.join("\n") + "\n\n");
    return;
  }
  // reveal mask: rows appear from the center outward
  const order = [...lines.keys()].sort((a, b) => Math.abs(a - lines.length / 2) - Math.abs(b - lines.length / 2));
  const shown = new Set<number>();
  for (const idx of order) {
    shown.add(idx);
    write("\x1b[s"); // save cursor
    for (let i = 0; i < lines.length; i++) write("\x1b[2K" + (shown.has(i) ? lines[i] : "") + "\n");
    write("\x1b[u"); // restore cursor
    await sleep(60);
  }
  write("\x1b[" + lines.length + "B");
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

/** Pure sparkline over a series, scaled to [min,max] (the coordinate's envelope). */
export function sparkline(series: number[], min: number, max: number, width = 32): string {
  if (series.length === 0) return "";
  const pts = series.slice(-width);
  const span = max - min || 1;
  return pts
    .map((v) => SPARK[Math.max(0, Math.min(SPARK.length - 1, Math.round(((v - min) / span) * (SPARK.length - 1))))])
    .join("");
}

/** Per-event flourish — themed glyphs + color, distinct per event kind. */
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
