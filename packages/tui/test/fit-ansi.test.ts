import { describe, it, expect } from "vitest";
import chalk from "chalk";
import { fitAnsi, visibleLength } from "../src/viewport.js";

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("fitAnsi (V6.5: responsive, ANSI-aware truncation)", () => {
  const long = "the quick brown fox jumps over the lazy dog and keeps running through the meadow";

  it("leaves short lines untouched at 60/80/120 columns", () => {
    for (const w of [60, 80, 120]) expect(fitAnsi("short line", w)).toBe("short line");
  });

  it("cuts long plain lines to the width, breaking at a word boundary", () => {
    for (const w of [40, 60]) {
      const out = fitAnsi(long, w);
      expect(visibleLength(out)).toBeLessThanOrEqual(w);
      expect(out.endsWith("…")).toBe(true);
      // Word boundary: the kept text ends exactly where a space followed in the original.
      const kept = out.slice(0, -1);
      expect(long.startsWith(kept)).toBe(true);
      expect(long.charAt(kept.length)).toBe(" ");
    }
    expect(fitAnsi(long, 120)).toBe(long); // fits at 120
  });

  it("keeps ANSI escapes whole and closes the style with a reset", () => {
    // Explicit escapes: chalk auto-disables colors outside a TTY, so build them by hand.
    const colored = "\x1b[36mlabel \x1b[31m" + long;
    const out = fitAnsi(colored, 40);
    expect(visibleLength(out)).toBeLessThanOrEqual(40);
    expect(out.endsWith("\x1b[0m")).toBe(true);
    // No escape sequence is ever cut in half.
    expect(out).not.toMatch(/\x1b\[[0-9;]*$/);
    expect(strip(out).endsWith("…")).toBe(true);
  });

  it("degrades to empty at unusable widths", () => {
    expect(fitAnsi(long, 1)).toBe("");
  });
});
