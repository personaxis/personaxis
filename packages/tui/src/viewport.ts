/**
 * Shared terminal-viewport primitives (F0.4): a resize-aware size hook plus a pure,
 * cursor-following list window. Every interactive list surface (the / palette, the
 * card selector, dashboard views) clamps to the terminal through these instead of
 * overflowing it, and re-renders when the terminal is resized.
 */

import { useEffect, useState } from "react";
import { useStdout } from "ink";

export interface TerminalSize {
  columns: number;
  rows: number;
}

/** Live terminal size; re-renders on resize. Safe defaults for pipes/CI (80x24). */
export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();
  const [size, setSize] = useState<TerminalSize>({
    columns: stdout?.columns ?? 80,
    rows: stdout?.rows ?? 24,
  });
  useEffect(() => {
    if (!stdout) return;
    const onResize = (): void => setSize({ columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 });
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);
  return size;
}

export interface ListWindow {
  /** Slice start (inclusive). */
  start: number;
  /** Slice end (exclusive). */
  end: number;
  /** Items hidden above / below the window. */
  above: number;
  below: number;
}

/**
 * A cursor-following window over `total` items showing at most `maxVisible`: the
 * cursor sits mid-window where possible and the window never overshoots either end
 * (the behavior the pre-Ink Screen menu had; now the single shared implementation).
 */
export function windowFor(total: number, cursor: number, maxVisible: number): ListWindow {
  const max = Math.max(1, Math.min(total, Math.floor(maxVisible)));
  const start = Math.min(Math.max(0, cursor - Math.floor(max / 2)), Math.max(0, total - max));
  const end = start + max;
  return { start, end, above: start, below: total - end };
}

/** Truncate a line to `width` columns with an ellipsis (keeps card heights predictable). */
export function fitLine(text: string, width: number): string {
  if (width <= 1) return text.slice(0, Math.max(0, width));
  return text.length > width ? text.slice(0, width - 1) + "…" : text;
}

const ANSI_TOKEN = /\x1b\[[0-9;]*m/y;

/**
 * ANSI-aware WORD WRAP (V7.A3). The terminal-resize corruption ("the output repeats
 * itself hundreds of times") came from letting the terminal wrap our lines: Ink erases
 * the live region by line COUNT, and a line that wraps to two rows breaks that count,
 * so the old frame is never fully erased and stacks up. We wrap ourselves, once, at
 * commit time, so every line Ink prints occupies exactly one row.
 */
export function wrapAnsi(text: string, width: number): string[] {
  if (width <= 1) return [text];
  const out: string[] = [];
  for (const rawLine of text.split("\n")) {
    if (visibleLength(rawLine) <= width) {
      out.push(rawLine);
      continue;
    }
    let cur = "";
    let visible = 0;
    let pendingStyles = "";
    const words = rawLine.split(/(\s+)/); // keep the separators
    for (const token of words) {
      const tokenVisible = visibleLength(token);
      if (visible + tokenVisible > width && visible > 0) {
        out.push(cur.replace(/\s+$/, ""));
        // Carry the active styles into the continuation line so color survives.
        cur = pendingStyles;
        visible = 0;
        if (/^\s+$/.test(token)) continue; // never start a line with the break space
      }
      // A single token longer than the width is hard-split.
      if (tokenVisible > width) {
        let rest = token;
        while (visibleLength(rest) > width - visible) {
          const take = fitAnsiRaw(rest, width - visible);
          out.push(cur + take);
          rest = rest.slice(take.length);
          cur = pendingStyles;
          visible = 0;
        }
        cur += rest;
        visible += visibleLength(rest);
      } else {
        cur += token;
        visible += tokenVisible;
      }
      for (const m of token.matchAll(/\x1b\[[0-9;]*m/g)) {
        pendingStyles = m[0] === "\x1b[0m" ? "" : pendingStyles + m[0];
      }
    }
    if (cur.trim()) out.push(cur);
  }
  return out.length ? out : [""];
}

/** Take exactly `width` visible chars, keeping escapes whole (no ellipsis). */
function fitAnsiRaw(text: string, width: number): string {
  let out = "";
  let visible = 0;
  let i = 0;
  while (i < text.length && visible < width) {
    ANSI_TOKEN.lastIndex = i;
    const m = ANSI_TOKEN.exec(text);
    if (m) {
      out += m[0];
      i = ANSI_TOKEN.lastIndex;
      continue;
    }
    out += text[i];
    visible += 1;
    i += 1;
  }
  return out;
}

/** Printable length of a string, ignoring ANSI color escapes. */
export function visibleLength(text: string): number {
  return text.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/**
 * ANSI-AWARE truncation (V6.5): `fitLine` sliced chalk-colored strings mid-escape,
 * corrupting the terminal and leaking styles into the next lines. This walks the
 * string, keeps escape sequences whole and zero-width, cuts the VISIBLE text at
 * `width-1` (preferring the last word boundary within reach), appends the
 * ellipsis, and closes any open style with a reset.
 */
export function fitAnsi(text: string, width: number): string {
  if (width <= 1) return "";
  if (visibleLength(text) <= width) return text;
  let out = "";
  let visible = 0;
  let sawEscape = false;
  let lastSpaceOut = -1; // out.length at the most recent visible space
  let i = 0;
  const budget = width - 1;
  while (i < text.length && visible < budget) {
    ANSI_TOKEN.lastIndex = i;
    const m = ANSI_TOKEN.exec(text);
    if (m) {
      out += m[0];
      sawEscape = true;
      i = ANSI_TOKEN.lastIndex;
      continue;
    }
    const ch = text[i];
    if (ch === " ") lastSpaceOut = out.length;
    out += ch;
    visible += 1;
    i += 1;
  }
  // Prefer a word boundary when one sits close to the cut.
  if (lastSpaceOut > 0 && out.length - lastSpaceOut <= 12) out = out.slice(0, lastSpaceOut);
  return out.replace(/\s+$/, "") + "…" + (sawEscape ? "\x1b[0m" : "");
}
