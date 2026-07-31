/**
 * V3.2 chrome: the `panel()` string helper behind /status /context /cost
 * /usage /doctor, and the ANSI-aware width it depends on. Pure strings, so the
 * same output renders in the Ink transcript and the non-TTY line mode.
 */
import { describe, it, expect } from "vitest";
import chalk from "chalk";
import { panel, visibleWidth } from "../src/repl/render.js";

describe("visibleWidth", () => {
  it("ignores ANSI styling", () => {
    const styled = chalk.bold.red("abc") + chalk.dim("de");
    expect(visibleWidth(styled)).toBe(5);
    expect(visibleWidth("plain")).toBe(5);
  });
});

describe("panel", () => {
  it("frames rows with a titled left rail", () => {
    const out = panel("status", ["  model  x", "  drift  ok"], 60);
    const lines = out.split("\n");
    expect(lines[0]).toContain("╭─");
    expect(lines[0]).toContain("status");
    expect(lines[1]).toContain("│");
    expect(lines[1]).toContain("model  x");
    expect(lines[2]).toContain("drift  ok");
    expect(lines[3]).toContain("╰");
    expect(lines).toHaveLength(4);
  });

  it("never collapses on narrow terminals", () => {
    const out = panel("a-fairly-long-panel-title", ["  row"], 20);
    expect(out.split("\n")[0]).toContain("a-fairly-long-panel-title");
    expect(out).toContain("╰");
  });
});
