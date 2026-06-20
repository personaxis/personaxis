/**
 * Governed episodic memory — bounded, provenance-tagged, append-only, auditable.
 *
 * The research is unambiguous (see plan/02-governed-memory, plan/11-security):
 * once untrusted content reaches long-term memory it persists and is later
 * retrieved as "trusted" context — the Zombie-Agent / memory-poisoning failure
 * mode. Defenses adopted here:
 *   - every entry carries a provenance source (user/tool/internal/synthesis);
 *   - entries form a hash chain (prev_hash -> hash): tamper-evident, time-travel
 *     auditable, MemLineage-style append-only log;
 *   - the writer is dry-run friendly (verify before commit).
 *
 * Stored as JSON Lines at <personaDir>/memory/episodic.jsonl so it diffs cleanly
 * in git and never mutates prior lines.
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProvenanceSource } from "./appraisal.js";

export interface MemoryEntry {
  ts: string;
  content: string;
  source: ProvenanceSource;
  tags: string[];
  /** Hash of the previous entry (lineage chain); "" for the first. */
  prev_hash: string;
  /** sha256 over {ts, content, source, tags, prev_hash}. */
  hash: string;
}

export interface MemoryWriteRequest {
  content: string;
  source: ProvenanceSource;
  tags?: string[];
}

function memoryPath(personaPath: string): string {
  return join(dirname(personaPath), "memory", "episodic.jsonl");
}

function hashEntry(e: Omit<MemoryEntry, "hash">): string {
  const h = createHash("sha256");
  h.update(JSON.stringify({ ts: e.ts, content: e.content, source: e.source, tags: e.tags, prev_hash: e.prev_hash }));
  return h.digest("hex");
}

export function readMemory(personaPath: string): MemoryEntry[] {
  const p = memoryPath(personaPath);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as MemoryEntry);
}

function lastHash(personaPath: string): string {
  const entries = readMemory(personaPath);
  return entries.length > 0 ? entries[entries.length - 1].hash : "";
}

/** Build (but do not write) the next entry — the dry-run half of write-path audit. */
export function prepareMemoryEntry(
  personaPath: string,
  req: MemoryWriteRequest,
): MemoryEntry {
  const base: Omit<MemoryEntry, "hash"> = {
    ts: new Date().toISOString(),
    content: req.content,
    source: req.source,
    tags: req.tags ?? [],
    prev_hash: lastHash(personaPath),
  };
  return { ...base, hash: hashEntry(base) };
}

/** Commit a prepared entry to the append-only log. */
export function commitMemoryEntry(personaPath: string, entry: MemoryEntry): void {
  const p = memoryPath(personaPath);
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify(entry) + "\n", "utf-8");
}

/** Verify the hash chain is intact (tamper / poisoning detection). */
export function verifyMemoryChain(personaPath: string): { ok: boolean; brokenAt?: number } {
  const entries = readMemory(personaPath);
  let prev = "";
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.prev_hash !== prev) return { ok: false, brokenAt: i };
    const recomputed = hashEntry({ ts: e.ts, content: e.content, source: e.source, tags: e.tags, prev_hash: e.prev_hash });
    if (recomputed !== e.hash) return { ok: false, brokenAt: i };
    prev = e.hash;
  }
  return { ok: true };
}
