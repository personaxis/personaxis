/**
 * Moving a persona's lived history aside when `create --yes` replaces its definition.
 *
 * A persona folder holds two kinds of files: what an author wrote (the definition, skills, references,
 * examples, assets, sub-personas) and what the persona accumulated by living (its state, its record, its
 * memory, its sessions, its self-edits). Replacing the definition and keeping the second kind made the new
 * persona start from the old one's values (E176, 2026-10-03). The history is a hash-chained record, so it
 * is moved, never deleted.
 */

import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Everything a persona writes beside its definition while it lives. Each name is owned elsewhere
 * (`record/store.ts`, `memory.ts`, `sessions.ts`, `multi-device.ts`, `self-evolution.ts`,
 * `recompile-marker.ts`, `compile/dist.ts`, `compile/history.ts`); a new runtime file has to be added here too.
 */
export const LIVED_HISTORY = [
  "state.json",
  "record.jsonl",
  "self-edits.jsonl",
  ".recompile-pending.json",
  "memory.md",
  "memory",
  "sessions",
  "devices",
  ".dist",
  "compiled",
] as const;

/**
 * True when the persona beside `personaPath` has lived nothing yet: its state never moved and it has no
 * sessions, memory, self-edits or devices. Its record then holds only its genesis.
 *
 * Why it exists: the agent provider re-runs `create` after every answer it writes, and each re-run writes
 * the same definition again over a persona created seconds before. Archiving that as a replaced persona
 * left a `previous/` folder per handoff (2026-10-07). A persona whose state moved is archived even when its
 * definition is written again unchanged, because whoever re-creates it asked for a fresh one.
 */
export function hasNotLived(personaPath: string): boolean {
  const base = dirname(personaPath);
  if (["self-edits.jsonl", "memory.md", "memory", "sessions", "devices"].some((name) => existsSync(join(base, name)))) return false;
  try {
    const state = JSON.parse(readFileSync(join(base, "state.json"), "utf-8")) as { mutation_log?: unknown[] };
    return (state.mutation_log ?? []).length === 0;
  } catch {
    return !existsSync(join(base, "state.json"));
  }
}

/**
 * Move every lived-history file beside `personaPath` into `previous/<timestamp>/`, and return that folder,
 * or undefined when there was nothing to move.
 */
export function movePersonaHistoryAside(personaPath: string, now: Date = new Date()): string | undefined {
  const base = dirname(personaPath);
  const present = LIVED_HISTORY.filter((name) => existsSync(join(base, name)));
  if (present.length === 0) return undefined;
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const target = join(base, "previous", stamp);
  mkdirSync(target, { recursive: true });
  for (const name of present) renameSync(join(base, name), join(target, name));
  return target;
}
