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
