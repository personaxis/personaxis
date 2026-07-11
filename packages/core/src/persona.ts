/**
 * Persona file IO for the engine.
 *
 * The engine operates on a known PERSONA.md path (the active persona's compiled
 * document) and its sibling state.json. Frontmatter carries the quantitative
 * envelopes; state.json carries the mutable current values + mutation_log.
 *
 * This is intentionally narrow: path *resolution* (root vs subagent slugs) lives
 * in the CLI's load.ts. The engine just reads/writes at given paths.
 */

import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import matter from "gray-matter";
import { extractEnvelopes } from "./envelopes.js";
import { withStateLock } from "./lock.js";

/**
 * Current state.json schema version (schema/state.schema.json's newest accepted
 * value, 0.9.0 added the optional agent_session block; 0.10 changed no state
 * fields). Single source for every seeder; keep in sync with the schema enum.
 */
export const STATE_SCHEMA_VERSION = "1.0.0";

export interface PersonaFrontmatter {
  [key: string]: unknown;
}

export interface MutationLogEntry {
  ts: string;
  field: string;
  from: number;
  to: number;
  delta_requested: number;
  clamped: boolean;
  reason: string;
  actor:
    | "actor-llm"
    | "runtime-decay"
    | "runtime-context"
    | "human-operator"
    | "judge-correction";
  tool_call_id?: string;
  governance_blocked?: boolean;
  /** v0.8: machine/instance that produced this mutation (cross-OS reconciliation). */
  origin_node?: string;
  /** v0.8: runtime session id, for traceability. */
  session_id?: string;
  /** v1.1 (F6.3, T3 forensic upgrade): hash of the previous chained entry ("" for
   *  the first). Same scheme as episodic memory, the audit trail is tamper-evident,
   *  not merely append-only by convention. Absent on pre-1.1 entries (legacy prefix
   *  tolerated by verifyMutationChain). */
  prev_hash?: string;
  /** v1.1: sha256 over {ts, field, from, to, delta_requested, clamped, reason,
   *  actor, governance_blocked, prev_hash}. */
  hash?: string;
}

export interface StateFile {
  schema_version: string;
  persona_id: string;
  persona_version: string;
  session_id?: string;
  values: Record<string, number>;
  active_context?: {
    task_mode: string | null;
    audience: string | null;
    additional_context_flags?: string[];
  };
  memory_anchors_active?: string[];
  mutation_log: MutationLogEntry[];
  last_compiled_at?: string | null;
  last_compiled_hash?: string | null;
  /** v0.9: live agent-loop session tracking (resumable across runs). */
  agent_session?: {
    active_task: string | null;
    started_at: string | null;
    step_count: number;
    token_count: number;
    cost_usd: number;
    stop_reason: string | null;
  };
}

/** A persona handle: resolved paths + parsed frontmatter. */
export interface PersonaHandle {
  /** Path to the compiled PERSONA.md (or .claude/agents/<slug>.md). */
  personaPath: string;
  /** Path to sibling state.json. */
  statePath: string;
  /** Parsed YAML frontmatter from PERSONA.md (quantitative layers + envelopes). */
  frontmatter: PersonaFrontmatter;
  /** Raw markdown body (the qualitative compiled document). */
  body: string;
}

export function loadPersona(personaPathArg: string): PersonaHandle {
  const personaPath = resolve(personaPathArg);
  if (!existsSync(personaPath)) {
    throw new Error(`PERSONA.md not found at ${personaPath}`);
  }
  const raw = readFileSync(personaPath, "utf-8");
  const parsed = matter(raw);
  return {
    personaPath,
    statePath: join(dirname(personaPath), "state.json"),
    frontmatter: (parsed.data ?? {}) as PersonaFrontmatter,
    body: parsed.content ?? "",
  };
}

export function readState(statePath: string): StateFile {
  if (!existsSync(statePath)) {
    throw new Error(
      `state.json not found at ${statePath}. Run 'personaxis state init' first.`,
    );
  }
  return JSON.parse(readFileSync(statePath, "utf-8")) as StateFile;
}

/**
 * Atomic write: temp file + rename in the same directory, so concurrent readers
 * (dash polling, another CLI) always see a complete JSON document, never a torn
 * partial write. Serialization of read→modify→write sequences is the caller's job
 * via withStateLock (see lock.ts).
 */
export function writeState(statePath: string, state: StateFile): void {
  const tmp = `${statePath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf-8");
  renameSync(tmp, statePath);
}

export function stateExists(statePath: string): boolean {
  return existsSync(statePath);
}

/** The human-facing name of a persona, from its frontmatter. */
export function displayName(fm: PersonaFrontmatter): string {
  const id = fm.identity as { display_name?: string; canonical_id?: string } | undefined;
  const meta = fm.metadata as { name?: string } | undefined;
  return id?.display_name ?? meta?.name ?? id?.canonical_id ?? "persona";
}

/**
 * Return the persona's state, seeding a fresh state.json from envelope means if
 * none exists yet. Keeps hosts (REPL, MCP) working out-of-the-box.
 */
export function ensureState(handle: PersonaHandle): StateFile {
  if (existsSync(handle.statePath)) return readState(handle.statePath);
  // Seeding races with other processes seeding the same persona, take the lock and
  // re-check so exactly one seeder wins.
  return withStateLock(handle.statePath, () => {
    if (existsSync(handle.statePath)) return readState(handle.statePath);
    const env = extractEnvelopes(handle.frontmatter);
    const meta = (handle.frontmatter.metadata ?? {}) as { name?: string; version?: string };
    const values: Record<string, number> = {};
    for (const [k, e] of Object.entries(env.envelopes)) values[k] = e.mean;
    const state: StateFile = {
      schema_version: STATE_SCHEMA_VERSION,
      persona_id: meta.name ?? "persona",
      persona_version: meta.version ?? "0.0.0",
      values,
      active_context: { task_mode: null, audience: null, additional_context_flags: [] },
      memory_anchors_active: [],
      mutation_log: [],
      last_compiled_at: null,
      last_compiled_hash: null,
    };
    writeState(handle.statePath, state);
    return state;
  });
}
