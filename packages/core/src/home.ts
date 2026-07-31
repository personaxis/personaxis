/**
 * The user-level home surfaces (V6.10): `~/.personaxis` structured like the
 * tool Claude Code itself uses (`~/.claude`), so the CLI works across many
 * projects with one global memory of activity:
 *
 *   history.jsonl      global cross-project prompt history (one line per user
 *                      turn: when, where, which persona, what was asked);
 *   stats-cache.json   per-day, per-model aggregates (tokens/turns/spend) fed
 *                      at session close, so Settings > Stats is instant and can
 *                      draw tokens/day per model without rescanning sessions.
 *
 * Everything is best-effort: a failure to record must never break a turn.
 * The full personaxis <-> claude-code map: docs/architecture/home-layout.md.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { personaxisHome } from "./registry.js";

export interface HistoryEntry {
  ts: string;
  cwd: string;
  persona: string;
  prompt: string;
}

const HISTORY_MAX_PROMPT = 500;

/** Append one user turn to the global history (cross-project, like ~/.claude/history.jsonl). */
export function appendHistory(entry: Omit<HistoryEntry, "ts">): void {
  try {
    const home = personaxisHome();
    mkdirSync(home, { recursive: true });
    const line: HistoryEntry = {
      ts: new Date().toISOString(),
      cwd: entry.cwd,
      persona: entry.persona,
      prompt: entry.prompt.slice(0, HISTORY_MAX_PROMPT),
    };
    appendFileSync(join(home, "history.jsonl"), JSON.stringify(line) + "\n", "utf-8");
  } catch {
    /* best-effort */
  }
}

/** The most recent global history entries, newest last. */
export function readHistory(limit = 100): HistoryEntry[] {
  try {
    const p = join(personaxisHome(), "history.jsonl");
    if (!existsSync(p)) return [];
    const lines = readFileSync(p, "utf-8").trim().split("\n");
    return lines.slice(-limit).flatMap((l) => {
      try {
        return [JSON.parse(l) as HistoryEntry];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

export interface ModelDayStats {
  tokens: number;
  turns: number;
  costUsd: number;
}

export interface StatsCache {
  /** yyyy-mm-dd -> model name -> aggregates. */
  days: Record<string, Record<string, ModelDayStats>>;
  updated: string;
}

function statsPath(): string {
  return join(personaxisHome(), "stats-cache.json");
}

export function readStatsCache(): StatsCache {
  try {
    const p = statsPath();
    if (!existsSync(p)) return { days: {}, updated: "" };
    return JSON.parse(readFileSync(p, "utf-8")) as StatsCache;
  } catch {
    return { days: {}, updated: "" };
  }
}

/** Fold a finished session's per-model usage into TODAY's bucket. */
export function recordSessionStats(byModel: Record<string, ModelDayStats>): void {
  try {
    const home = personaxisHome();
    mkdirSync(home, { recursive: true });
    const cache = readStatsCache();
    const day = new Date().toISOString().slice(0, 10);
    const bucket = (cache.days[day] ??= {});
    for (const [model, s] of Object.entries(byModel)) {
      const cur = (bucket[model] ??= { tokens: 0, turns: 0, costUsd: 0 });
      cur.tokens += s.tokens;
      cur.turns += s.turns;
      cur.costUsd += s.costUsd;
    }
    cache.updated = new Date().toISOString();
    writeFileSync(statsPath(), JSON.stringify(cache, null, 2) + "\n", "utf-8");
  } catch {
    /* best-effort */
  }
}
