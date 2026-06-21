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

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import matter from "gray-matter";
import { extractEnvelopes } from "./envelopes.js";

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

export function writeState(statePath: string, state: StateFile): void {
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");
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
  const env = extractEnvelopes(handle.frontmatter);
  const meta = (handle.frontmatter.metadata ?? {}) as { name?: string; version?: string };
  const values: Record<string, number> = {};
  for (const [k, e] of Object.entries(env.envelopes)) values[k] = e.mean;
  const state: StateFile = {
    schema_version: "0.7.0",
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
}
