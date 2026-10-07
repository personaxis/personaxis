/**
 * Moving a persona's lived history aside when `create --yes` replaces its definition.
 *
 * A persona folder holds two kinds of files: what an author wrote (the definition, skills, references,
 * examples, assets, sub-personas) and what the persona accumulated by living (its state, its record, its
 * memory, its sessions, its self-edits). Replacing the definition and keeping the second kind made the new
 * persona start from the old one's values (E176, 2026-10-03). The history is a hash-chained record, so it
 * is moved, never deleted.
 */

import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Everything a persona writes beside its definition while it lives. Each name is owned elsewhere
 * (`record/store.ts`, `memory.ts`, `sessions.ts`, `multi-device.ts`, `self-evolution.ts`,
 * `recompile-marker.ts`, `compile/dist.ts`); a new runtime file has to be added here too.
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
] as const;

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
