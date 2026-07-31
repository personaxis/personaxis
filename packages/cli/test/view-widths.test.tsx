/**
 * V8.F5: every view renders sanely at 60, 80 and 120 columns.
 *
 * Two failures this catches, both of which shipped before:
 *   - a line wider than the terminal WRAPS, which breaks the row count Ink erases by and
 *     leaves debris on screen (the header that stacked up while resizing);
 *   - a list taller than the terminal pushes the input and the key hints off the bottom,
 *     making a view unusable exactly when it finally has real data in it.
 *
 * Rendered through Ink with an INJECTED stdout, not through ink-testing-library: that
 * library's stdout reports a hard-coded 100 columns, so a width test written on top of it
 * would measure its canvas and pass no matter what the view does.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React from "react";
import { render } from "ink";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerTabbedView } from "../src/repl/views/tabbed.js";
import { settingsProvider, personaProvider } from "../src/repl/views/interactive.js";
import { driftProvider } from "../src/repl/views/drift-view.js";
import { doctorProvider } from "../src/repl/views/doctor-view.js";
import { CommandCenter } from "../src/command-center.js";
import { makeCtx } from "../src/repl/session.js";
import { makeMeter } from "../src/repl/config.js";
import { writeStarterPersona } from "../src/starter.js";

process.env.PERSONAXIS_NO_ANIM = "1";

const WIDTHS = [60, 80, 120];
const strip = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

let dir: string;
let personaPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pxs-widths-"));
  personaPath = writeStarterPersona(dir, "Vega");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Render into a terminal of exactly this size and return what it painted. */
async function paint(node: React.ReactElement, cols: number, rows = 24): Promise<string> {
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
  Object.assign(stdout, { columns: cols, rows, isTTY: true });
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  Object.assign(stdin, { isTTY: true, setRawMode: () => stdin, ref: () => {}, unref: () => {} });
  // The LAST frame, not every frame concatenated: Ink repaints, and gluing repaints
  // together measures two screens as one row and reports double the real width.
  const frames: string[] = [];
  stdout.on("data", (c: Buffer) => frames.push(c.toString()));

  const instance = render(node, { stdout, stdin, patchConsole: false, exitOnCtrlC: false });
  await new Promise((r) => setTimeout(r, 120));
  instance.unmount();
  return [...frames].reverse().find((f) => strip(f).trim().length > 0) ?? "";
}

/** Content rows, without ANSI and without the trailing padding Ink adds. */
function rowsOf(painted: string): string[] {
  return strip(painted)
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.length > 0);
}

const widest = (painted: string): number => Math.max(0, ...rowsOf(painted).map((l) => l.length));

const VIEWS: Array<[string, (ctx: ReturnType<typeof makeCtx>) => ReturnType<typeof settingsProvider>]> = [
  ["settings", settingsProvider],
  ["persona", personaProvider],
  ["drift", driftProvider],
  ["doctor", doctorProvider],
];

describe("miniapps fit the terminal (V8.F5)", () => {
  for (const [name, provider] of VIEWS) {
    for (const cols of WIDTHS) {
      it(`${name} at ${cols} columns: no row exceeds the width`, async () => {
        const ctx = makeCtx(personaPath, makeMeter());
        const View = registerTabbedView(`w-${name}-${cols}`, provider(ctx));
        const painted = await paint(
          <View personaPath={personaPath} active={true} onBack={() => {}} />,
          cols,
        );
        expect(rowsOf(painted).length, "the view must render something").toBeGreaterThan(0);
        expect(widest(painted), `${name} overflows at ${cols} cols`).toBeLessThanOrEqual(cols);
      });
    }
  }

  it("a very long value is truncated, not wrapped", async () => {
    const ctx = makeCtx(personaPath, makeMeter());
    const View = registerTabbedView("w-long", {
      title: "long",
      tabs: ["One"],
      lines: () => [{ label: "huge", value: "x".repeat(400) }],
    });
    const painted = await paint(<View personaPath={personaPath} active={true} onBack={() => {}} />, 60);
    expect(widest(painted)).toBeLessThanOrEqual(60);
    // Truncated, not wrapped: the value must not continue onto a second row.
    expect(rowsOf(painted).filter((l) => l.includes("xxxx")).length).toBe(1);
  });

  it("a list taller than the terminal is windowed", async () => {
    const ctx = makeCtx(personaPath, makeMeter());
    const View = registerTabbedView("w-tall", {
      title: "tall",
      tabs: ["One"],
      lines: () => Array.from({ length: 200 }, (_, i) => `  row number ${i}`),
    });
    const painted = await paint(<View personaPath={personaPath} active={true} onBack={() => {}} />, 80, 14);
    expect(rowsOf(painted).length, "the frame must not exceed the terminal height").toBeLessThanOrEqual(16);
  });
});

/**
 * V8.F3: the height budget, at the size where budgets actually break.
 *
 * A view that windows correctly at 24 rows can still blow past a terminal of 8, because
 * the budget is a subtraction and subtractions go negative. If that happens, the key hints
 * and the input go off the bottom: the view becomes unusable exactly when the person has
 * the least room to recover.
 */
describe("no view outgrows a tiny terminal (V8.F3)", () => {
  for (const rows of [8, 12]) {
    it(`a 200-row list still fits ${rows} rows, and still says how to get out`, async () => {
      const ctx = makeCtx(personaPath, makeMeter());
      const View = registerTabbedView(`h-${rows}`, {
        title: "tall",
        tabs: ["One"],
        lines: () => Array.from({ length: 200 }, (_, i) => `  row number ${i}`),
      });
      const painted = await paint(<View personaPath={personaPath} active={true} onBack={() => {}} />, 80, rows);
      const out = rowsOf(painted);
      expect(out.length, `the frame must fit ${rows} rows`).toBeLessThanOrEqual(rows + 2);
      expect(out.join("\n"), "the way out must survive the squeeze").toMatch(/Esc/);
    });
  }
});

describe("the Command Center fits too (V8.F5)", () => {
  for (const cols of WIDTHS) {
    it(`fleet at ${cols} columns stays inside the frame`, async () => {
      const painted = await paint(
        <CommandCenter personaPath={personaPath} personas={[]} cwd={dir} initialSection="fleet" />,
        cols,
      );
      expect(widest(painted), `command center overflows at ${cols}`).toBeLessThanOrEqual(cols);
    });
  }

  it("a long fleet is windowed and says what is hidden", async () => {
    const subs = Array.from({ length: 20 }, (_, i) => `helper${i}`);
    for (const s of subs) writeStarterPersona(dir, s, s);
    const painted = await paint(
      <CommandCenter personaPath={personaPath} personas={subs} cwd={dir} initialSection="fleet" />,
      80,
      16,
    );
    const rows = rowsOf(painted);
    expect(rows.length).toBeLessThanOrEqual(20);
    expect(rows.join("\n"), "it must say what is hidden, not silently cut").toMatch(/more below|more above/);
  });
});
