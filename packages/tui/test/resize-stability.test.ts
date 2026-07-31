/**
 * Resizing the window used to garble the screen and repeat the output over and over, as if
 * stuck in a loop.
 *
 * Root cause: every committed line was re-rendered on resize (Transcript subscribed to
 * the terminal width) AND long lines were left for the terminal to wrap. Ink erases its
 * live region by LINE COUNT, so a row that wraps into two breaks the count and the old
 * frame is never fully erased, stacking up.
 *
 * The contract now: we wrap ourselves, once, at commit time. Every row we hand to Ink
 * fits the width it was printed at, and history never reflows.
 */
import { describe, it, expect } from "vitest";
import { wrapAnsi, visibleLength, fitAnsi } from "../src/viewport.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createReplStore } from "../src/ink-repl.js";

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("wrapAnsi (V7.A3)", () => {
  const long =
    "The agent no longer repeats its output when you resize the window, because every line is wrapped exactly once, at the width it was printed at.";

  it("every produced row fits the width, at 40/60/80/120 columns", () => {
    for (const w of [40, 60, 80, 120]) {
      for (const row of wrapAnsi(long, w)) {
        expect(visibleLength(row), `width ${w}: "${row}"`).toBeLessThanOrEqual(w);
      }
    }
  });

  it("preserves the words (nothing lost, nothing duplicated)", () => {
    const rejoined = wrapAnsi(long, 37).join(" ").replace(/\s+/g, " ").trim();
    expect(rejoined).toBe(long);
  });

  it("keeps ANSI colors alive across the break", () => {
    const colored = "\x1b[36m" + long + "\x1b[0m";
    const rows = wrapAnsi(colored, 40);
    expect(rows.length).toBeGreaterThan(1);
    // The continuation row re-opens the style instead of losing the color.
    expect(rows[1]).toContain("\x1b[36m");
    expect(strip(rows.join(" ")).replace(/\s+/g, " ").trim()).toBe(long);
  });

  it("hard-splits a single token longer than the width", () => {
    const rows = wrapAnsi("x".repeat(100), 20);
    expect(rows.length).toBe(5);
    for (const r of rows) expect(visibleLength(r)).toBeLessThanOrEqual(20);
  });

  it("short lines and empty input are untouched", () => {
    expect(wrapAnsi("corto", 80)).toEqual(["corto"]);
    expect(wrapAnsi("", 80)).toEqual([""]);
  });
});

describe("committed history is frozen at print width (V7.A3)", () => {
  it("stores the width used, so a later resize cannot reflow it", () => {
    const store = createReplStore();
    const before = process.stdout.columns;
    Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });
    store.getState().append("una linea impresa a cien columnas", "system");
    // The terminal shrinks AFTER the line was committed.
    Object.defineProperty(process.stdout, "columns", { value: 40, configurable: true });
    store.getState().append("otra linea impresa a cuarenta columnas", "system");
    const items = store.getState().committed;
    expect(items[0].width).toBe(98);
    expect(items[1].width).toBe(38);
    // The first entry keeps its original text: history does not reflow.
    expect(items[0].text).toBe("una linea impresa a cien columnas");
    Object.defineProperty(process.stdout, "columns", { value: before, configurable: true });
  });

  it("wraps at commit time so no committed row can wrap in the terminal", () => {
    const store = createReplStore();
    const before = process.stdout.columns;
    Object.defineProperty(process.stdout, "columns", { value: 50, configurable: true });
    store.getState().append("palabra ".repeat(30).trim(), "persona");
    const item = store.getState().committed[0];
    for (const row of item.text.split("\n")) expect(visibleLength(row)).toBeLessThanOrEqual(48);
    Object.defineProperty(process.stdout, "columns", { value: before, configurable: true });
  });
});

/**
 * THE SECOND HALF OF THE SAME BUG, reported after the transcript was fixed: the
 * DYNAMIC region (header + status line) had no width limit of its own. A status
 * line longer than the terminal wraps to a second row, Ink still erases it as
 * one, and every resize leaves another copy behind:
 *
 *   ─ Clio (main)  ·  cli  ·  workspace-write
 *   ─ Clio (main)  ·  cli  ·  workspace-write
 *   ─ Clio (main)  ·  cli  ·  workspace-write   … and so on down the screen
 *
 * The invariant: everything in the dynamic region occupies exactly ONE row at
 * any width, truncated rather than wrapped, with colour kept intact.
 */
describe("the dynamic region is one row at any width (V7.A3b)", () => {
  const status =
    "\x1b[2m░░░░░░░░ 3.7K/256.0K 1%  ·  $0.072  ·  7.6s  ·  improve suggesting  ·  workspace-write shift+tab\x1b[0m";
  const header = "\x1b[1m◈ Clio\x1b[0m (main)  ·  cli  ·  workspace-write  ·  \x1b[36msuggesting\x1b[0m";

  it("never exceeds the width it is given, at 40/60/80/120 columns", () => {
    for (const w of [40, 60, 80, 120]) {
      for (const line of [status, header]) {
        const fitted = fitAnsi(line, w);
        expect(visibleLength(fitted), `width ${w}`).toBeLessThanOrEqual(w);
        expect(fitted.includes("\n"), "must never wrap to a second row").toBe(false);
      }
    }
  });

  it("keeps colour escapes whole and closes them, so styles never leak", () => {
    const fitted = fitAnsi(status, 30);
    // No escape sequence may be cut in half by the truncation.
    for (const chunk of fitted.split("\x1b[")) {
      if (chunk === fitted.split("\x1b[")[0]) continue;
      expect(/^[0-9;]*m/.test(chunk), `truncation split an escape: ${JSON.stringify(fitted)}`).toBe(true);
    }
    expect(fitted.endsWith("\x1b[0m"), "an open style must be closed at the cut").toBe(true);
  });

  it("a line that already fits is returned untouched", () => {
    const short = "\x1b[2m· ready\x1b[0m";
    expect(fitAnsi(short, 80)).toBe(short);
  });
});

/**
 * THE STRUCTURAL RULE behind the stacking, and the one a layout change is most
 * likely to break again.
 *
 * Ink writes <Static> output permanently ABOVE the dynamic region. Anything
 * rendered before it in the tree is therefore re-emitted into the scrollback on
 * every repaint rather than erased, which is why the header piled up while the
 * window was being resized:
 *
 *   ─ Clio (main)  ·  cli  ·  workspace-write
 *   ─ Clio (main)  ·  cli  ·  workspace-write      (once per repaint)
 *
 * So: <Static> must be the FIRST thing the app renders. Asserted against the
 * source, because the symptom only shows on a real terminal being dragged, and a
 * screenshot is not a regression test.
 */
describe("nothing renders above <Static> (V7.A3c)", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "ink-repl.tsx"), "utf-8");
  const appBody = src.slice(src.indexOf("function ReplApp"), src.indexOf("export class InkScreen"));
  // The whole component body: <Transcript> and the header each appear once, so
  // their relative order in the source IS their render order.
  const returnBlock = appBody;

  it("the header is rendered after the transcript, not before it", () => {
    const transcriptAt = returnBlock.indexOf("<Transcript");
    const headerAt = returnBlock.indexOf("hooks.header");
    expect(transcriptAt, "the transcript must be in the render").toBeGreaterThan(-1);
    expect(headerAt, "the header must be in the render").toBeGreaterThan(-1);
    expect(headerAt, "the header must come AFTER the transcript that holds <Static>").toBeGreaterThan(transcriptAt);
  });

  it("the status line and input also stay below it", () => {
    const transcriptAt = returnBlock.indexOf("<Transcript");
    // lastIndexOf: the const is DECLARED above the JSX; what matters is where it is RENDERED.
    expect(returnBlock.lastIndexOf("statusLine"), "status after transcript").toBeGreaterThan(transcriptAt);
    expect(returnBlock.indexOf("<TextInput"), "input after transcript").toBeGreaterThan(transcriptAt);
  });
});
