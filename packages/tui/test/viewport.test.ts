import { describe, it, expect } from "vitest";
import { windowFor, fitLine } from "../src/viewport.js";

describe("windowFor (cursor-following list window)", () => {
  it("shows everything when the list fits", () => {
    expect(windowFor(5, 2, 10)).toEqual({ start: 0, end: 5, above: 0, below: 0 });
  });

  it("pins to the top when the cursor is early", () => {
    expect(windowFor(30, 0, 8)).toEqual({ start: 0, end: 8, above: 0, below: 22 });
    expect(windowFor(30, 3, 8)).toEqual({ start: 0, end: 8, above: 0, below: 22 });
  });

  it("centers the cursor mid-list", () => {
    const w = windowFor(30, 15, 8);
    expect(w.start).toBe(11);
    expect(w.end).toBe(19);
    expect(w.above + w.below + (w.end - w.start)).toBe(30);
  });

  it("pins to the bottom at the end (cursor stays visible)", () => {
    const w = windowFor(30, 29, 8);
    expect(w).toEqual({ start: 22, end: 30, above: 22, below: 0 });
  });

  it("every cursor position lands inside its window", () => {
    for (let c = 0; c < 30; c++) {
      const w = windowFor(30, c, 7);
      expect(c).toBeGreaterThanOrEqual(w.start);
      expect(c).toBeLessThan(w.end);
    }
  });

  it("never returns a zero-height window", () => {
    expect(windowFor(3, 0, 0).end).toBeGreaterThan(0);
  });
});

describe("fitLine", () => {
  it("passes short lines through", () => {
    expect(fitLine("abc", 10)).toBe("abc");
  });
  it("truncates with an ellipsis at exactly the width", () => {
    expect(fitLine("abcdefghij", 5)).toBe("abcd…");
    expect(fitLine("abcdefghij", 5)).toHaveLength(5);
  });
});
