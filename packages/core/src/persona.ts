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
import { genesisEntry, type RecordEntry } from "./record/entry.js";
import { readRecord, recordPathFor, seedRecord } from "./record/store.js";
import { derive, deriveFrom, type DeriveResult } from "./record/derive.js";
import { holds } from "./record/chain.js";
import { project } from "./record/project.js";

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
   *  tolerated by `record.verify`). */
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
 * Return the persona's state, seeding it from envelope means if there is none yet.
 *
 * ## What seeding writes, and why it changed
 *
 * It used to write a `state.json` holding every declared coordinate at its envelope
 * mean and an empty `mutation_log`: a persona whose numbers appear with nobody named.
 * On the reference example that was eleven of twelve values with no origin anybody
 * could point at, which is a small hole in an ordinary log and an unacceptable one in
 * a chain sold as proof, because "where did this number come from" is the first
 * question and the honest answer was nowhere.
 *
 * It writes the origins into the record instead, and prints the file from them. The
 * migration could already reconstruct origins for an existing persona, but
 * reconstructing is not the same as knowing: an untouched coordinate is recovered as
 * "whatever it holds now", so if the spec's declared mean changes later, the
 * reconstruction reports the new mean as where it started. Written at initialisation,
 * the origin is what was actually declared at the time.
 */
/**
 * Where a persona is, reading only, or nothing when it has not started yet.
 *
 * The counterpart to `ensureState` and the difference is the whole point: looking at
 * a persona must not create it. A view that seeds one turns browsing into a write,
 * so opening a list of personas would bring every one of them into existence and a
 * freshly created sub-persona would stop being able to say it has not been set up.
 *
 * `undefined` rather than envelope means, because "this persona has not started" and
 * "this persona is at its declared starting position" are different situations that
 * happen to hold the same numbers, and only one of them is worth telling somebody
 * about.
 *
 * The record first, for the same reason `ensureState` reads it first: `state.json` is
 * printed from it, so reading the file rather than the record is reading a copy.
 */
export function stateOf(handle: PersonaHandle): StateFile | undefined {
  const entries = readRecord(recordPathFor(handle.personaPath));
  const stored = existsSync(handle.statePath) ? readState(handle.statePath) : undefined;
  if (entries.length > 0) return projectPersona(handle, entries, stored);

  return stored;
}

export function ensureState(handle: PersonaHandle): StateFile {
  // The record first, and this is the whole point of the step. `state.json` is
  // printed from the record, so reading the file instead of the record is reading a
  // copy, and a copy is only right until somebody edits it. Every reader that asked
  // the file rather than the record was a second source waiting to disagree.
  //
  // Nothing is written here. A file that has fallen behind is not repaired by looking
  // at it: reading returns the truth, and `state rebuild --write` is the deliberate
  // repair. A read that writes would touch the mtime of every persona anybody
  // glanced at, and would take the lock to do it.
  const entries = readRecord(recordPathFor(handle.personaPath));
  if (entries.length > 0) {
    return projectPersona(handle, entries, existsSync(handle.statePath) ? readState(handle.statePath) : undefined);
  }

  // No record: a persona from before this existed, whose file is still its history.
  // The migration happens on its first write, wherever that write comes from:
  // `writingToRecord` adopts the file before the writer touches the record.
  if (existsSync(handle.statePath)) return readState(handle.statePath);
  // Seeding races with other processes seeding the same persona, take the lock and
  // re-check so exactly one seeder wins.
  return withStateLock(handle.statePath, () => {
    if (existsSync(handle.statePath)) return readState(handle.statePath);
    const env = extractEnvelopes(handle.frontmatter);
    const meta = (handle.frontmatter.metadata ?? {}) as { name?: string; version?: string };
    const values: Record<string, number> = {};
    for (const [k, e] of Object.entries(env.envelopes)) values[k] = e.mean;
    // The origins first, so the file is printed from a record rather than asserted.
    // Sorted, because two personas seeded from the same spec should produce the same
    // chain, and object key order is not something to rest that on.
    // A persona whose record already exists is not a new persona, whatever happened
    // to its state file. Seeding again would refuse, and it would be wrong to allow:
    // the origins are already written, and the file is a view of them. So the view is
    // printed again, which is what makes `state init --force` and a deleted state file
    // both do the harmless thing rather than the destructive one.
    const existing = readRecord(recordPathFor(handle.personaPath));
    if (existing.length > 0) return print(handle, existing);

    const at = new Date().toISOString();
    const entries = seedRecord(
      handle.personaPath,
      Object.keys(values)
        .sort()
        .map((field) => genesisEntry(field, values[field], at)),
    );

    // Printed, not asserted. Building the object here by hand is how the seeded file
    // came to differ from every file written after it: it carried
    // `last_compiled_at: null` and `last_compiled_hash: null`, and the published
    // schema declares both as strings, so a brand new persona failed validation
    // against the spec this project ships. A projection cannot drift from itself.
    return print(handle, entries);
  });
}

/**
 * The state file a persona's record says it has, without writing anything.
 *
 * Separated from writing it so a caller can ask what the file OUGHT to say and
 * compare, which is what checking a projection for drift is.
 *
 * Building the object by hand is how the seeded file came to differ from every file
 * written after it: it carried `last_compiled_at: null` and `last_compiled_hash:
 * null`, and the published schema declares both as strings, so a brand new persona
 * failed validation against the spec this project ships. A projection cannot drift
 * from itself.
 */
export function projectPersona(
  handle: PersonaHandle,
  entries: readonly RecordEntry[],
  stored?: StateFile,
): StateFile {
  // Folded from the last checkpoint rather than from the beginning. The entries are
  // in hand either way, because the projected `mutation_log` is the whole history and
  // reading it is what the file's format asks for; what this avoids is re-verifying
  // and re-folding every one of them, which is the larger half of the cost and the
  // half that grows without bound. The spec allows trimming that log under a
  // retention policy, and doing so is what would make this flat rather than merely
  // cheaper. That policy belongs with the entries a conversation will add, because
  // the right window depends on what is in there, and inventing one now would be
  // guessing at a volume that does not exist yet.
  const folded = foldFromCheckpoint(entries);
  if (!folded.ok) {
    throw new Error(
      `the record beside this persona does not verify (${folded.problem.kind} at entry ${folded.problem.seq}), so its state cannot be printed`,
    );
  }
  const meta = (handle.frontmatter.metadata ?? {}) as { name?: string; version?: string };
  return project(folded.state, entries, {
    // What the file already declares wins over what this build writes. Printing the
    // current constant over a persona that says 0.6.0 would raise its declared schema
    // version as a side effect of reprinting a view, and raising a schema version is a
    // migration: `personaxis migrate` does it deliberately, with a report, and this
    // would have done it silently. The two answers lived in two places, one in
    // `adjust` and one here, and they disagreed on a real persona.
    schemaVersion: stored?.schema_version ?? STATE_SCHEMA_VERSION,
    personaId: stored?.persona_id ?? meta.name ?? "persona",
    personaVersion: stored?.persona_version ?? meta.version ?? "0.0.0",
    ...(stored?.session_id === undefined ? {} : { sessionId: stored.session_id }),
  });
}

/**
 * Fold entries already in memory, starting from the last checkpoint among them.
 *
 * The same shortcut `stateFrom` takes off the disk, for a caller that has already
 * had to read the file for another reason. The checkpoint's own hash is recomputed
 * before it is believed, because it is the one entry this does not walk a chain to.
 */
function foldFromCheckpoint(entries: readonly RecordEntry[]): DeriveResult {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.body.type !== "checkpoint" || !holds(entry)) continue;

    return deriveFrom(entry.body.state, entries.slice(index + 1), {
      seq: entry.seq + 1,
      prev: entry.hash,
    });
  }
  return derive(entries);
}

/** The same document, left on disk. */
function print(handle: PersonaHandle, entries: readonly RecordEntry[]): StateFile {
  // Only reached when the file is absent, so there is nothing stored to preserve.
  const state = projectPersona(handle, entries);
  writeState(handle.statePath, state);
  return state;
}
