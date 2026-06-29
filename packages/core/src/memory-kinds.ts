/**
 * The non-episodic memory kinds (F4) — procedural, autobiographical, user_preferences,
 * evaluations. The spec's `memory.types` declares six flags; episodic + semantic live in
 * memory.ts. These four were previously declared-but-unenforced; here they become real,
 * each honoring its flag at the producer call site (the established pattern — see
 * loop.ts / agent.ts gating episodic on `readMemoryTypes(...).episodic`).
 *
 * Storage mirrors episodic memory: append-only JSONL under `<personaDir>/memory/`, except
 * user_preferences which is a small last-wins JSON map. Dependency-free (node:fs only).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MemoryEntry } from "./memory.js";

function memDir(personaPath: string): string {
  return join(dirname(personaPath), "memory");
}
function kindPath(personaPath: string, file: string): string {
  return join(memDir(personaPath), file);
}
function appendJsonl(personaPath: string, file: string, row: unknown): void {
  const p = kindPath(personaPath, file);
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify(row) + "\n", "utf-8");
}
function readJsonl<T>(personaPath: string, file: string): T[] {
  const p = kindPath(personaPath, file);
  if (!existsSync(p)) return [];
  const out: T[] = [];
  for (const line of readFileSync(p, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      /* skip a corrupt line */
    }
  }
  return out;
}

// ── procedural: reusable "how a task was accomplished" ───────────────────────
export interface ProceduralEntry {
  ts: string;
  task: string;
  procedure: string;
  tags: string[];
}

export function appendProcedural(personaPath: string, req: { task: string; procedure: string; tags?: string[] }): ProceduralEntry {
  const entry: ProceduralEntry = { ts: new Date().toISOString(), task: req.task, procedure: req.procedure, tags: req.tags ?? [] };
  appendJsonl(personaPath, "procedural.jsonl", entry);
  return entry;
}
export function readProcedural(personaPath: string, limit = 200): ProceduralEntry[] {
  return readJsonl<ProceduralEntry>(personaPath, "procedural.jsonl").slice(-limit);
}

// ── autobiographical: identity-level milestones ──────────────────────────────
export interface AutobiographicalEntry {
  ts: string;
  event: string;
  detail?: string;
  tags: string[];
}

export function appendAutobiographical(personaPath: string, req: { event: string; detail?: string; tags?: string[] }): AutobiographicalEntry {
  const entry: AutobiographicalEntry = { ts: new Date().toISOString(), event: req.event, tags: req.tags ?? [], ...(req.detail ? { detail: req.detail } : {}) };
  appendJsonl(personaPath, "autobiographical.jsonl", entry);
  return entry;
}
export function readAutobiographical(personaPath: string, limit = 200): AutobiographicalEntry[] {
  return readJsonl<AutobiographicalEntry>(personaPath, "autobiographical.jsonl").slice(-limit);
}

// ── user_preferences: stable user-stated preferences (last-wins map) ──────────
export interface PreferenceValue {
  value: string;
  ts: string;
  rationale?: string;
}

export function setPreference(personaPath: string, key: string, value: string, rationale?: string): void {
  const prefs = readPreferences(personaPath);
  prefs[key] = { value, ts: new Date().toISOString(), ...(rationale ? { rationale } : {}) };
  const p = kindPath(personaPath, "preferences.json");
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(prefs, null, 2) + "\n", "utf-8");
}
export function readPreferences(personaPath: string): Record<string, PreferenceValue> {
  const p = kindPath(personaPath, "preferences.json");
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as Record<string, PreferenceValue>;
  } catch {
    return {};
  }
}
export function getPreference(personaPath: string, key: string): string | undefined {
  return readPreferences(personaPath)[key]?.value;
}

// ── evaluations: quality/utility scoring of memories & turns ──────────────────
export type EvalDimension = "usefulness" | "accuracy" | "safety";
export interface EvaluationEntry {
  ts: string;
  /** What was scored: a memory hash (`#abc12345`) or a turn marker (`turn`). */
  target: string;
  dimension: EvalDimension;
  score: number; // 0..1
  rationale: string;
}

export function recordEvaluation(personaPath: string, req: { target: string; dimension: EvalDimension; score: number; rationale: string }): EvaluationEntry {
  const entry: EvaluationEntry = { ts: new Date().toISOString(), target: req.target, dimension: req.dimension, score: clamp01(req.score), rationale: req.rationale };
  appendJsonl(personaPath, "evaluations.jsonl", entry);
  return entry;
}
export function readEvaluations(personaPath: string, limit = 200): EvaluationEntry[] {
  return readJsonl<EvaluationEntry>(personaPath, "evaluations.jsonl").slice(-limit);
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/**
 * Deterministic, offline quality scorer for an episodic memory entry. Returns one
 * evaluation per dimension. Heuristic (no LLM): safety reflects whether the content was
 * injection-flagged; usefulness rewards substantive, user/synthesis-sourced content.
 */
export function scoreMemoryEntry(entry: MemoryEntry, opts: { injectionBlocked?: boolean } = {}): Array<Omit<EvaluationEntry, "ts">> {
  const target = `#${entry.hash.slice(0, 8)}`;
  const flagged = opts.injectionBlocked || entry.tags.includes("injection-flagged");
  const safety = flagged ? 0 : 1;
  const len = entry.content.trim().length;
  const sourceWeight = entry.source === "user" || entry.source === "synthesis" ? 0.6 : 0.35;
  const lengthWeight = Math.min(0.4, len / 600);
  const usefulness = flagged ? 0.1 : clamp01(sourceWeight + lengthWeight);
  return [
    { target, dimension: "safety", score: safety, rationale: flagged ? "injection-flagged content" : "no injection signal" },
    { target, dimension: "usefulness", score: usefulness, rationale: `source=${entry.source}, ${len} chars` },
  ];
}
