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

export const LOGO = [
  "  ___  ___ _ __ ___  ___  _ __   __ ___  _____ ____ ",
  " / _ \\/ _ \\ '__/ __|/ _ \\| '_ \\ / _` \\ \\/ /_ _/ ___|",
  "|  __/  __/ |  \\__ \\ (_) | | | | (_| |>  < | |\\___ \\",
  " \\___|\\___|_|  |___/\\___/|_| |_|\\__,_/_/\\_\\___|____/",
];

const TAGLINE =
  chalk.dim("  living, governed personas · ") + chalk.cyan("/help") + chalk.dim(" · ") + chalk.cyan("/exit");

/** Animated wordmark reveal with a color sweep; static fallback off-TTY. */
export async function animateLogo(): Promise<void> {
  const purple = chalk.bold.magentaBright;
  if (!supportsAnim()) {
    write("\n" + LOGO.map((l) => purple(l)).join("\n") + "\n" + TAGLINE + "\n\n");
    return;
  }
  write("\n");
  // reveal line by line
  for (const line of LOGO) {
    write(purple(line) + "\n");
    await sleep(55);
  }
  // brief shimmer sweep across the wordmark
  for (let s = 0; s < 3; s++) {
    write("\x1b[" + (LOGO.length + 0) + "A");
    for (let i = 0; i < LOGO.length; i++) {
      const c = (s + i) % 2 === 0 ? chalk.magentaBright : chalk.magenta;
      write("\x1b[2K" + c(LOGO[i]) + "\n");
    }
    await sleep(70);
  }
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
    const pos = barIndex(v, { ...e, mean: 0 }, width);
    let bar = "";
    for (let i = 0; i < width; i++) bar += i === pos ? chalk.ansi256(theme.palette.accent)("◉") : chalk.ansi256(theme.palette.dim)("─");
    rows.push(`  ${k.padEnd(28)} ${bar} ${chalk.dim(v.toFixed(2))}`);
  }
  return rows.join("\n");
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
