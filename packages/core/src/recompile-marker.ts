/**
 * Recompile-pending marker, the "stale" signal that closes the self-evolution loop.
 *
 * When a governed self-edit is APPLIED (overlay changes), the compiled PERSONA.md no longer
 * reflects the spec. Core cannot compile (that needs an LLM, which lives in the CLI/host), so
 * it drops a small sentinel next to personaxis.md. A consumer that CAN compile, the REPL
 * (with a provider) or the host driving MCP, recompiles and clears it. `personaxis compile`
 * clears it automatically; `compile --if-pending` is a cheap no-op when nothing is stale.
 */

import { writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";

export interface RecompileState {
  pending: boolean;
  reason?: string;
  ts?: string;
}

function markerPath(personaPath: string): string {
  return join(dirname(personaPath), ".recompile-pending.json");
}

/** Mark the persona's compiled doc as stale (idempotent). */
export function markRecompilePending(personaPath: string, reason: string): void {
  writeFileSync(markerPath(personaPath), JSON.stringify({ pending: true, reason, ts: new Date().toISOString() }, null, 2) + "\n", "utf-8");
}

export function readRecompilePending(personaPath: string): RecompileState {
  const p = markerPath(personaPath);
  if (!existsSync(p)) return { pending: false };
  try {
    const j = JSON.parse(readFileSync(p, "utf-8")) as RecompileState;
    return { pending: true, reason: j.reason, ts: j.ts };
  } catch {
    return { pending: true };
  }
}

/** Clear the marker (called after a successful compile). */
export function clearRecompilePending(personaPath: string): void {
  const p = markerPath(personaPath);
  if (existsSync(p)) rmSync(p);
}
