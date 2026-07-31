import { describe, it, expect } from "vitest";
import { lineChart, heatmapGitHub } from "../src/charts.js";

const strip = (s: string): string => s.replace(/\[[0-9;]*m/g, "");

describe("lineChart (V6.4)", () => {
  it("renders a labeled Y axis, the curve glyphs and the legend", () => {
    const out = lineChart([{ label: "tokens", points: [0, 2, 8, 4, 4, 9, 1] }], {
      height: 5,
      xLabels: ["May 28", "Jul 11"],
    }).map(strip);
    const text = out.join("\n");
    expect(text).toContain("9"); // top Y label
    expect(text).toContain("┼"); // axis corner
    expect(text).toMatch(/[╭╮╰╯]/); // curve turns
    expect(text).toContain("● tokens"); // legend
    expect(text).toContain("May 28");
    expect(text).toContain("Jul 11");
  });

  it("is deterministic and handles multi-series", () => {
    const series = [
      { label: "a", points: [1, 5, 3], color: 4 },
      { label: "b", points: [2, 2, 6], color: 5 },
    ];
    expect(lineChart(series, { height: 4 })).toEqual(lineChart(series, { height: 4 }));
    const text = lineChart(series, { height: 4 }).map(strip).join("\n");
    expect(text).toContain("● a");
    expect(text).toContain("● b");
  });

  it("degrades gracefully with no data", () => {
    expect(strip(lineChart([], {}).join("\n"))).toContain("no data");
  });
});

describe("heatmapGitHub (V6.4)", () => {
  it("renders month labels, Mon/Wed/Fri gutter and the Less..More legend", () => {
    const today = new Date("2026-07-19T12:00:00Z");
    const days = new Map<string, number>([
      ["2026-07-15", 3],
      ["2026-07-10", 1],
      ["2026-06-20", 9],
    ]);
    const out = heatmapGitHub(days, 12, today).map(strip);
    const text = out.join("\n");
    expect(out).toHaveLength(1 + 7 + 1); // months + 7 day rows + legend
    expect(text).toContain("Mon");
    expect(text).toContain("Wed");
    expect(text).toContain("Fri");
    expect(text).toMatch(/May|Jun/); // at least one month label in a 12-week window
    expect(text).toContain("Jul");
    expect(text).toContain("Less ░ ▒ ▓ █ More");
    expect(text).toMatch(/[░▒▓█]/); // some activity shading
  });

  it("is deterministic for a fixed today", () => {
    const today = new Date("2026-07-19T12:00:00Z");
    const days = new Map<string, number>([["2026-07-01", 2]]);
    expect(heatmapGitHub(days, 8, today)).toEqual(heatmapGitHub(days, 8, today));
  });
});
