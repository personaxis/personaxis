/**
 * Live-sync (F5).
 *
 * When a persona's runtime state drifts, a host watching the compiled doc must be
 * able to tell. The compiled `PERSONA.md` is a *purely qualitative* document, so we
 * never inject numeric state into it. Instead the drift is synced deterministically:
 *
 *   - write a `.live.json` notify marker (state hash + counts + current values + ts)
 *     a host watcher can poll to know "the persona changed";
 *   - self-heal: if an older version left a delimited LIVE-STATE block inside the
 *     compiled doc, strip it (state belongs in state.json / .live.json, not in prose).
 *
 * This is the loop's `recompile` hook. The qualitative recompile remains a separate,
 * provider-backed step; nothing here invents or mutates prose.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureState, type PersonaHandle, type StateFile } from "./persona.js";

export const LIVE_START = "<!-- PERSONAXIS:LIVE-STATE start -->";
export const LIVE_END = "<!-- PERSONAXIS:LIVE-STATE end -->";

/**
 * Remove a residual LIVE-STATE block (and its surrounding blank space) from a compiled
 * doc. Idempotent: returns the input unchanged when no block is present. Used to migrate
 * docs written by older versions that injected numeric state into the prose.
 */
export function stripLiveBlock(doc: string): string {
  const start = doc.indexOf(LIVE_START);
  const end = doc.indexOf(LIVE_END);
  if (start === -1 || end === -1 || end < start) return doc;
  const before = doc.slice(0, start).replace(/\s+$/, "");
  const after = doc.slice(end + LIVE_END.length).replace(/^\s+/, "");
  return after ? `${before}\n\n${after}` : `${before}\n`;
}

export interface LiveMarker {
  ts: string;
  state_hash: string;
  mutations: number;
  values: Record<string, number>;
}

function markerPath(personaPath: string): string {
  return join(dirname(personaPath), ".live.json");
}

export function stateHash(state: StateFile): string {
  return createHash("sha256").update(JSON.stringify(state.values)).digest("hex").slice(0, 16);
}

/** Write the notify marker beside the persona; returns it. */
export function writeLiveMarker(personaPath: string, state: StateFile): LiveMarker {
  const marker: LiveMarker = {
    ts: new Date().toISOString(),
    state_hash: stateHash(state),
    mutations: state.mutation_log.length,
    values: state.values,
  };
  writeFileSync(markerPath(personaPath), JSON.stringify(marker, null, 2) + "\n", "utf-8");
  return marker;
}

/**
 * Sync runtime state: write the `.live.json` marker and self-heal the compiled doc by
 * stripping any residual LIVE-STATE block. The compiled doc's prose is never written
 * with numeric state.
 */
export function liveSync(handle: PersonaHandle, compiledPath: string | undefined, state: StateFile): LiveMarker {
  if (compiledPath && existsSync(compiledPath)) {
    const doc = readFileSync(compiledPath, "utf-8");
    const cleaned = stripLiveBlock(doc);
    if (cleaned !== doc) writeFileSync(compiledPath, cleaned, "utf-8");
  }
  return writeLiveMarker(handle.personaPath, state);
}

export interface RecompileHookOptions {
  /** Path to the compiled doc to keep in sync (marker + live-block self-heal). */
  compiledPath?: string;
}

/**
 * Build a `recompile` hook for the LivingLoop: on numeric drift it writes the `.live.json`
 * notify marker (and strips any residual live block from the compiled doc). Rewriting the
 * document itself is a model's job since 2026-10-07 (`personaxis compile`; the CLI's session
 * hook starts it in the background); until then this hook could rewrite it with the assembled
 * template, which no persona gets any more.
 */
export function makeRecompileHook(
  opts?: string | RecompileHookOptions,
): (handle: PersonaHandle) => Promise<void> {
  const options: RecompileHookOptions = typeof opts === "string" ? { compiledPath: opts } : opts ?? {};
  return async (handle: PersonaHandle) => {
    const state = ensureState(handle);
    liveSync(handle, options.compiledPath, state);
  };
}
