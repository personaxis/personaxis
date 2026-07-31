/**
 * ASCII charts (V6.4): one tested module for every chart the TUI draws, so
 * stats stop being improvised text. Pure functions of their data (colors via
 * chalk in the cells; deterministic, snapshot-testable).
 *
 *   lineChart    multi-series time chart with a labeled Y axis and X date
 *                marks, in the ╭╮╰╯│─ style (the asciichart algorithm).
 *   heatmapGitHub  GitHub-contributions layout: month labels on top, Mon/Wed/
 *                Fri on the left, ░▒▓█ shading, Less..More legend.
 */

import chalk from "chalk";

export interface LineSeries {
  label: string;
  points: number[];
  /** ansi256 color for the series (and its legend dot). */
  color?: number;
}

export interface LineChartOptions {
  /** Plot height in rows (default 8). */
  height?: number;
  /** Format for Y-axis labels (default compact k/M). */
  fmt?: (v: number) => string;
  /** X-axis labels, placed at first / middle / last column. */
  xLabels?: [string, string, string] | [string, string] | [string];
}

const compact = (v: number): string => {
  if (Math.abs(v) >= 1_000_000) return (v / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (Math.abs(v) >= 1_000) return (v / 1_000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(Math.round(v));
};

/** Multi-series ASCII line chart. Later series draw over earlier ones. */
export function lineChart(series: LineSeries[], opts: LineChartOptions = {}): string[] {
  const H = Math.max(3, opts.height ?? 8);
  const fmt = opts.fmt ?? compact;
  const n = Math.max(...series.map((s) => s.points.length), 0);
  if (!n || !series.length) return [chalk.dim("  (no data)")];
  const all = series.flatMap((s) => s.points);
  const min = Math.min(...all, 0);
  const max = Math.max(...all);
  const range = max - min || 1;
  const ratio = (H - 1) / range;
  const level = (v: number): number => Math.round((v - min) * ratio);

  // Empty grid: H rows by n columns.
  const grid: string[][] = Array.from({ length: H }, () => Array.from({ length: n }, () => " "));
  for (const s of series) {
    const paint = (ch: string): string => (s.color !== undefined ? chalk.ansi256(s.color)(ch) : ch);
    for (let i = 0; i < s.points.length; i++) {
      const y1 = level(s.points[i]);
      if (i === 0) {
        grid[H - 1 - y1][0] = paint("─");
        continue;
      }
      const y0 = level(s.points[i - 1]);
      if (y0 === y1) {
        grid[H - 1 - y1][i] = paint("─");
      } else {
        grid[H - 1 - y1][i] = paint(y0 > y1 ? "╰" : "╭");
        grid[H - 1 - y0][i] = paint(y0 > y1 ? "╮" : "╯");
        for (let y = Math.min(y0, y1) + 1; y < Math.max(y0, y1); y++) grid[H - 1 - y][i] = paint("│");
      }
    }
  }

  // Y axis: label the top, middle and bottom rows.
  const labelFor = (row: number): string => fmt(min + ((H - 1 - row) / (H - 1)) * range);
  const gutter = Math.max(...[0, Math.floor(H / 2), H - 1].map((r) => labelFor(r).length));
  const lines: string[] = [];
  for (let r = 0; r < H; r++) {
    const showLabel = r === 0 || r === Math.floor(H / 2) || r === H - 1;
    const label = showLabel ? labelFor(r).padStart(gutter) : " ".repeat(gutter);
    const axis = r === H - 1 ? "┼" : showLabel ? "┤" : "│";
    lines.push(`  ${chalk.dim(label)} ${chalk.dim(axis)}${grid[r].join("")}`);
  }
  if (opts.xLabels?.length) {
    const xs = opts.xLabels;
    // The label row grows past the plot width when the labels need the room.
    const width = Math.max(n, xs.reduce((sum, t) => sum + t.length, 0) + (xs.length - 1) * 2);
    const rowArr = Array.from({ length: width }, () => " ");
    const put = (text: string, at: number): void => {
      const start = Math.max(0, Math.min(width - text.length, at));
      for (let i = 0; i < text.length && start + i < width; i++) rowArr[start + i] = text[i];
    };
    put(xs[0], 0);
    if (xs.length === 3) put(xs[1], Math.floor(width / 2) - Math.floor(xs[1].length / 2));
    if (xs.length >= 2) put(xs[xs.length - 1], width - xs[xs.length - 1].length);
    lines.push(`  ${" ".repeat(gutter)}  ${chalk.dim(rowArr.join(""))}`);
  }
  const legend = series
    .map((s) => (s.color !== undefined ? chalk.ansi256(s.color)("●") : "●") + ` ${s.label}`)
    .join(chalk.dim(" · "));
  lines.push(`  ${" ".repeat(gutter)}  ${legend}`);
  return lines;
}

const SHADES = ["·", "░", "▒", "▓", "█"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** GitHub-contributions heatmap: `days` maps yyyy-mm-dd to a count. */
export function heatmapGitHub(days: Map<string, number>, weeks = 12, today = new Date()): string[] {
  const max = Math.max(1, ...days.values());
  // Grid anchored so the LAST column ends on today; columns are weeks (Sun-start).
  const end = new Date(today);
  end.setDate(end.getDate() + (6 - (end.getDay() % 7))); // end of this week
  const start = new Date(end);
  start.setDate(end.getDate() - weeks * 7 + 1);
  const cellFor = (d: Date): string => {
    if (d > today) return " ";
    const v = days.get(d.toISOString().slice(0, 10)) ?? 0;
    return v === 0 ? chalk.dim(SHADES[0]) : SHADES[Math.min(4, 1 + Math.floor((v / max) * 3))];
  };
  // Month labels: place each abbreviation at the week column where the month starts.
  const dayNames = ["", "Mon", "", "Wed", "", "Fri", ""];
  const gutter = 4;
  let lastMonth = -1;
  const monthLine = Array.from({ length: weeks + 4 }, () => " ");
  for (let w = 0; w < weeks; w++) {
    const d = new Date(start);
    d.setDate(start.getDate() + w * 7);
    if (d.getMonth() !== lastMonth) {
      const text = MONTHS[d.getMonth()];
      for (let i = 0; i < text.length && w + i < monthLine.length; i++) monthLine[w + i] = text[i];
      lastMonth = d.getMonth();
    }
  }
  const lines: string[] = [`  ${" ".repeat(gutter)}${chalk.dim(monthLine.join("").replace(/\s+$/, ""))}`];
  for (let row = 0; row < 7; row++) {
    const cells: string[] = [];
    for (let w = 0; w < weeks; w++) {
      const d = new Date(start);
      d.setDate(start.getDate() + w * 7 + row);
      cells.push(cellFor(d));
    }
    lines.push(`  ${chalk.dim(dayNames[row].padEnd(gutter))}${cells.join("")}`);
  }
  lines.push(`  ${" ".repeat(gutter)}${chalk.dim(`Less ${SHADES.slice(1).join(" ")} More`)}`);
  return lines;
}
