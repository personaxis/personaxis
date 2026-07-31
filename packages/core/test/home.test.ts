/**
 * V6.10: the user-level home surfaces. History is global and cross-project
 * (one line per user turn); the stats cache folds per-model usage into per-day
 * buckets at session close. PERSONAXIS_HOME is hermetic per worker (setup-home).
 */
import { describe, it, expect } from "vitest";
import { appendHistory, readHistory, readStatsCache, recordSessionStats } from "../src/home.js";

describe("global history (V6.10)", () => {
  it("appends and reads back cross-project prompt history, newest last", () => {
    appendHistory({ cwd: "C:/proj/a", persona: "Vega", prompt: "hola" });
    appendHistory({ cwd: "C:/proj/b", persona: "Clio", prompt: "valida el spec" });
    const h = readHistory(10);
    expect(h.length).toBeGreaterThanOrEqual(2);
    const last = h[h.length - 1];
    expect(last.persona).toBe("Clio");
    expect(last.cwd).toBe("C:/proj/b");
    expect(last.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("truncates giant prompts and never throws", () => {
    appendHistory({ cwd: "C:/proj", persona: "V", prompt: "x".repeat(5000) });
    const h = readHistory(1);
    expect(h[0].prompt.length).toBeLessThanOrEqual(500);
  });
});

describe("stats cache (V6.10)", () => {
  it("folds per-model usage into today's bucket, accumulating across sessions", () => {
    const today = new Date().toISOString().slice(0, 10);
    recordSessionStats({ "command-a": { tokens: 1000, turns: 2, costUsd: 0.05 } });
    recordSessionStats({
      "command-a": { tokens: 500, turns: 1, costUsd: 0.02 },
      "gpt-x": { tokens: 200, turns: 1, costUsd: 0.01 },
    });
    const cache = readStatsCache();
    expect(cache.days[today]["command-a"].tokens).toBe(1500);
    expect(cache.days[today]["command-a"].turns).toBe(3);
    expect(cache.days[today]["gpt-x"].tokens).toBe(200);
    expect(cache.updated).toMatch(/^\d{4}/);
  });
});
