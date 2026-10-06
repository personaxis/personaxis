/**
 * The non-episodic memory kinds (F4), procedural, autobiographical, user_preferences,
 * evaluations. The spec's `memory.types` declares six flags; episodic + semantic live in
 * memory.ts. These four were previously declared-but-unenforced; here they become real,
 * each honoring its flag at the producer call site (the established pattern, see
 * loop.ts / agent.ts gating episodic on `readMemoryTypes(...).episodic`).
 *
 * Storage mirrors episodic memory: append-only JSONL under `<personaDir>/memory/`, except
 * user_preferences which is a small last-wins JSON map. Dependency-free (node:fs only).
 *
 * ── E16: every write is owned, bounded and validated ─────────────────────────
 *
 * These four kinds are read back INTO THE PROMPT (`agent.ts` folds the last procedural
 * and autobiographical entries plus every preference into the system context), so they
 * close the loop the episodic log was hardened against and this module was not:
 * outside content reaches memory, and the next turn reads it as the persona's own.
 * That is OWASP ASI06, memory poisoning, and it is a risk a multi-persona engine
 * introduces BY EXISTING, because one persona's memory is another's context.
 *
 * Three properties, none of which held before:
 *
 *   OWNER    every entry names who wrote it, in the SAME provenance vocabulary the
 *            episodic chain uses. Without it a poisoned entry cannot even be
 *            investigated after the fact: the log says what, never who. It is a
 *            REQUIRED argument, not a defaulted one, so each producer had to state
 *            its own answer rather than inherit a comfortable one.
 *
 *   CAP      a cap on the WRITE, not on the read. The pre-E16 `limit = 200` arguments
 *            bounded what a reader returned while the file behind them grew forever
 *            and was parsed in full on every turn to serve the last few lines. What
 *            overflows is moved to `<kind>.overflow.jsonl`, never deleted: an
 *            audit that ends where the cap begins is not an audit.
 *
 *   VALIDATE writes are checked and REFUSED with a reason, not silently truncated.
 *            Truncation is what made the old cap look real: `agent.ts` sliced to 400
 *            chars before calling, so the limit lived at one call site and nowhere
 *            else. A refusal is visible; a trim is not.
 *
 * And one rule that is a judgement, not a bound: AUTOBIOGRAPHICAL REFUSES `tool`.
 * That kind is the persona's account of itself, and it is read back as identity. A
 * tool result is the one source that arrives from outside the trust boundary, so it
 * may inform an answer, and it may not write who someone is.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProvenanceSource } from "./appraisal.js";
import type { MemoryEntry } from "./memory.js";

/**
 * Who wrote a memory. Deliberately the SAME union the episodic chain carries
 * (`ProvenanceSource`) rather than a second vocabulary for the same question: two
 * spellings of one fact is the failure this codebase keeps paying for.
 */
export type MemoryOwner = ProvenanceSource;

export type MemoryKindName = "procedural" | "autobiographical" | "user_preferences" | "evaluations";

/**
 * The bound for each kind. Entries are the file's length; the char fields bound a
 * SINGLE entry, so neither a long write nor many short ones can crowd the context.
 *
 * The numbers are this module's, not the spec's. `memory.types` declares WHICH kinds
 * exist and `runtime.memory.max_items` bounds RETRIEVAL; the spec says nothing about a
 * durable per-kind cap, and inventing a key for it is a spec change, not an
 * implementation detail. They are stated here, in the open, until that is decided.
 */
export interface MemoryCap {
  maxEntries: number;
  fields: Record<string, number>;
}

export const MEMORY_CAPS: Record<MemoryKindName, MemoryCap> = {
  // Read back three at a time into the prompt; 500 keeps a long history searchable.
  procedural: { maxEntries: 500, fields: { task: 200, procedure: 2000 } },
  autobiographical: { maxEntries: 500, fields: { event: 200, detail: 1000 } },
  // Keys, not rows. EVERY preference is injected into context, so this cap is the
  // one that directly bounds the prompt.
  user_preferences: { maxEntries: 200, fields: { key: 100, value: 500, rationale: 500 } },
  // Small rows, never injected into the prompt: they feed scoring and the audit view.
  evaluations: { maxEntries: 2000, fields: { target: 100, rationale: 500 } },
};

/**
 * The outcome of a write. A refusal carries its reason so a caller can surface it;
 * before E16 an over-long or unowned write either succeeded silently or was trimmed
 * by whichever call site remembered to.
 */
export type MemoryWriteResult<T> =
  | { ok: true; entry: T; pruned: number }
  | { ok: false; reason: string };

const OWNERS: readonly MemoryOwner[] = ["user", "tool", "internal", "synthesis"];

function isOwner(v: unknown): v is MemoryOwner {
  return typeof v === "string" && (OWNERS as readonly string[]).includes(v);
}

/**
 * Field-level validation shared by every kind. Returns a reason on refusal and
 * `undefined` when the value is acceptable. Empty-after-trim is refused: a blank
 * milestone is not a milestone, and it still occupies a line of the prompt.
 */
function refuse(kind: MemoryKindName, field: string, value: string, required: boolean): string | undefined {
  if (!required && value === "") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return `${kind}.${field} is empty`;
  const max = MEMORY_CAPS[kind].fields[field];
  if (max !== undefined && trimmed.length > max) {
    return `${kind}.${field} is ${trimmed.length} chars, over the ${max} cap`;
  }
  return undefined;
}

function memDir(personaPath: string): string {
  return join(dirname(personaPath), "memory");
}
function kindPath(personaPath: string, file: string): string {
  return join(memDir(personaPath), file);
}

/**
 * Append one row, then enforce the cap by moving the OLDEST rows into the kind's
 * overflow log. Returns how many rows moved.
 *
 * Keeping the tail is the right default for these kinds (recent how-tos and recent
 * milestones are what a turn needs), but it is not free: a flood of writes pushes
 * good entries out of the live file. That is why overflow is a MOVE and not a
 * delete, and why the caps above are generous enough that a flood is visible as a
 * flood rather than as quiet forgetting.
 */
function appendCapped(personaPath: string, kind: MemoryKindName, file: string, row: unknown): number {
  const p = kindPath(personaPath, file);
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify(row) + "\n", "utf-8");

  const lines = readFileSync(p, "utf-8").split("\n").filter((l) => l.trim().length > 0);
  const max = MEMORY_CAPS[kind].maxEntries;
  if (lines.length <= max) return 0;

  const overflow = lines.slice(0, lines.length - max);
  const kept = lines.slice(lines.length - max);
  appendFileSync(overflowPath(personaPath, file), overflow.join("\n") + "\n", "utf-8");
  writeFileSync(p, kept.join("\n") + "\n", "utf-8");
  return overflow.length;
}

/** Where capped-out rows go. Never read into context; kept so the audit is complete. */
export function overflowPath(personaPath: string, file: string): string {
  return kindPath(personaPath, file.replace(/\.jsonl$/, ".overflow.jsonl"));
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

/**
 * Rows written before E16 carry no owner. They are read as `internal`, which is what
 * they were in fact: the engine wrote every one of them. Guessing anything richer
 * would put a name on a row that never had one.
 */
function ownerOf(raw: unknown): MemoryOwner {
  return isOwner((raw as { owner?: unknown } | null)?.owner) ? ((raw as { owner: MemoryOwner }).owner) : "internal";
}

// ── procedural: reusable "how a task was accomplished" ───────────────────────
export interface ProceduralEntry {
  ts: string;
  task: string;
  procedure: string;
  tags: string[];
  owner: MemoryOwner;
}

export function appendProcedural(
  personaPath: string,
  req: { task: string; procedure: string; tags?: string[]; owner: MemoryOwner },
): MemoryWriteResult<ProceduralEntry> {
  if (!isOwner(req.owner)) return { ok: false, reason: `procedural owner "${String(req.owner)}" is not a provenance source` };
  const bad =
    refuse("procedural", "task", req.task ?? "", true) ??
    refuse("procedural", "procedure", req.procedure ?? "", true);
  if (bad) return { ok: false, reason: bad };

  const entry: ProceduralEntry = {
    ts: new Date().toISOString(),
    task: req.task.trim(),
    procedure: req.procedure.trim(),
    tags: req.tags ?? [],
    owner: req.owner,
  };
  return { ok: true, entry, pruned: appendCapped(personaPath, "procedural", "procedural.jsonl", entry) };
}

export function readProcedural(personaPath: string, limit = 200): ProceduralEntry[] {
  return readJsonl<ProceduralEntry>(personaPath, "procedural.jsonl")
    .map((e) => ({ ...e, owner: ownerOf(e) }))
    .slice(-limit);
}

// ── autobiographical: identity-level milestones ──────────────────────────────
export interface AutobiographicalEntry {
  ts: string;
  event: string;
  detail?: string;
  tags: string[];
  owner: MemoryOwner;
}

export function appendAutobiographical(
  personaPath: string,
  req: { event: string; detail?: string; tags?: string[]; owner: MemoryOwner },
): MemoryWriteResult<AutobiographicalEntry> {
  if (!isOwner(req.owner)) return { ok: false, reason: `autobiographical owner "${String(req.owner)}" is not a provenance source` };
  // The judgement of this module: what came from outside does not get to say who
  // the persona is. Everything else about a tool result stays usable.
  if (req.owner === "tool") {
    return { ok: false, reason: "autobiographical memory refuses tool-owned writes: a tool result cannot author identity" };
  }
  const bad =
    refuse("autobiographical", "event", req.event ?? "", true) ??
    refuse("autobiographical", "detail", req.detail ?? "", false);
  if (bad) return { ok: false, reason: bad };

  const entry: AutobiographicalEntry = {
    ts: new Date().toISOString(),
    event: req.event.trim(),
    tags: req.tags ?? [],
    owner: req.owner,
    ...(req.detail?.trim() ? { detail: req.detail.trim() } : {}),
  };
  return { ok: true, entry, pruned: appendCapped(personaPath, "autobiographical", "autobiographical.jsonl", entry) };
}

export function readAutobiographical(personaPath: string, limit = 200): AutobiographicalEntry[] {
  return readJsonl<AutobiographicalEntry>(personaPath, "autobiographical.jsonl")
    .map((e) => ({ ...e, owner: ownerOf(e) }))
    .slice(-limit);
}

// ── user_preferences: stable user-stated preferences (last-wins map) ──────────
export interface PreferenceValue {
  value: string;
  ts: string;
  rationale?: string;
  owner: MemoryOwner;
}

/**
 * Last-wins per key, and REFUSING rather than evicting once the key cap is reached.
 *
 * Eviction is the wrong failure here and it is the whole attack: every preference is
 * injected into the prompt, so a writer that can push 200 junk keys would otherwise
 * push out the ones the user actually stated. Refusing the new key keeps what was
 * already earned, and an EXISTING key can always be updated, so a full map never
 * blocks a correction.
 */
export function setPreference(
  personaPath: string,
  key: string,
  value: string,
  rationale: string | undefined,
  owner: MemoryOwner,
): MemoryWriteResult<PreferenceValue> {
  if (!isOwner(owner)) return { ok: false, reason: `user_preferences owner "${String(owner)}" is not a provenance source` };
  const bad =
    refuse("user_preferences", "key", key ?? "", true) ??
    refuse("user_preferences", "value", value ?? "", true) ??
    refuse("user_preferences", "rationale", rationale ?? "", false);
  if (bad) return { ok: false, reason: bad };

  const prefs = readPreferences(personaPath);
  const k = key.trim();
  const cap = MEMORY_CAPS.user_preferences.maxEntries;
  if (prefs[k] === undefined && Object.keys(prefs).length >= cap) {
    return { ok: false, reason: `user_preferences is at its ${cap}-key cap; existing keys can still be updated` };
  }

  const entry: PreferenceValue = {
    value: value.trim(),
    ts: new Date().toISOString(),
    owner,
    ...(rationale?.trim() ? { rationale: rationale.trim() } : {}),
  };
  prefs[k] = entry;
  const p = kindPath(personaPath, "preferences.json");
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(prefs, null, 2) + "\n", "utf-8");
  return { ok: true, entry, pruned: 0 };
}

export function readPreferences(personaPath: string): Record<string, PreferenceValue> {
  const p = kindPath(personaPath, "preferences.json");
  if (!existsSync(p)) return {};
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Record<string, PreferenceValue>;
    const out: Record<string, PreferenceValue> = {};
    for (const [k, v] of Object.entries(raw)) out[k] = { ...v, owner: ownerOf(v) };
    return out;
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
  owner: MemoryOwner;
}

export function recordEvaluation(
  personaPath: string,
  req: { target: string; dimension: EvalDimension; score: number; rationale: string; owner: MemoryOwner },
): MemoryWriteResult<EvaluationEntry> {
  if (!isOwner(req.owner)) return { ok: false, reason: `evaluations owner "${String(req.owner)}" is not a provenance source` };
  if (req.dimension !== "usefulness" && req.dimension !== "accuracy" && req.dimension !== "safety") {
    return { ok: false, reason: `evaluations dimension "${String(req.dimension)}" is not a scored dimension` };
  }
  if (typeof req.score !== "number" || !Number.isFinite(req.score)) {
    return { ok: false, reason: "evaluations score is not a finite number" };
  }
  const bad =
    refuse("evaluations", "target", req.target ?? "", true) ??
    refuse("evaluations", "rationale", req.rationale ?? "", true);
  if (bad) return { ok: false, reason: bad };

  const entry: EvaluationEntry = {
    ts: new Date().toISOString(),
    target: req.target.trim(),
    dimension: req.dimension,
    score: clamp01(req.score),
    rationale: req.rationale.trim(),
    owner: req.owner,
  };
  return { ok: true, entry, pruned: appendCapped(personaPath, "evaluations", "evaluations.jsonl", entry) };
}

export function readEvaluations(personaPath: string, limit = 200): EvaluationEntry[] {
  return readJsonl<EvaluationEntry>(personaPath, "evaluations.jsonl")
    .map((e) => ({ ...e, owner: ownerOf(e) }))
    .slice(-limit);
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/**
 * Deterministic, offline quality scorer for an episodic memory entry. Returns one
 * evaluation per dimension. Heuristic (no LLM): safety reflects whether the content was
 * injection-flagged; usefulness rewards substantive, user/synthesis-sourced content.
 *
 * The scores are the ENGINE's own reading of what it just wrote, so they are owned
 * `internal`: nothing outside the process contributed to them.
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
    { target, dimension: "safety", score: safety, rationale: flagged ? "injection-flagged content" : "no injection signal", owner: "internal" },
    { target, dimension: "usefulness", score: usefulness, rationale: `source=${entry.source}, ${len} chars`, owner: "internal" },
  ];
}
