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
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProvenanceSource } from "./appraisal.js";

/**
 * The spec's `memory.types` map (MUST). The runtime now HONORS these instead of
 * always writing episodic. `episodic` defaults to true only when the persona
 * declares no `memory` block (backward compatibility); once declared, the flags
 * are authoritative — a persona with `episodic: false` writes nothing to the log.
 */
export interface MemoryTypes {
  episodic: boolean;
  semantic: boolean;
  procedural: boolean;
  autobiographical: boolean;
  user_preferences: boolean;
  evaluations: boolean;
}

export function readMemoryTypes(frontmatter: Record<string, unknown>): MemoryTypes {
  const mem = frontmatter.memory as { types?: Record<string, unknown> } | undefined;
  const declared = mem?.types;
  const flag = (k: string, dflt: boolean): boolean =>
    declared && typeof declared[k] === "boolean" ? (declared[k] as boolean) : dflt;
  // No memory block at all → keep episodic on so existing personas still record.
  const episodicDefault = mem === undefined;
  return {
    episodic: flag("episodic", episodicDefault),
    semantic: flag("semantic", false),
    procedural: flag("procedural", false),
    autobiographical: flag("autobiographical", false),
    user_preferences: flag("user_preferences", false),
    evaluations: flag("evaluations", false),
  };
}

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

/**
 * Honor deletion_policy.user_request_supported WITHOUT breaking the append-only
 * chain: append a tombstone that supersedes a prior entry. The original line is
 * never rewritten (chain stays verifiable); live readers filter it out. The
 * deletion itself is thus auditable — you can prove what was removed and when.
 */
export function tombstoneMemory(
  personaPath: string,
  targetHash: string,
  reason: string,
): MemoryEntry {
  const entry = prepareMemoryEntry(personaPath, {
    content: `[deleted by user request: ${reason}]`,
    source: "user",
    tags: ["tombstone", `target:${targetHash}`],
  });
  commitMemoryEntry(personaPath, entry);
  return entry;
}

/** Read memory with tombstoned entries (and the tombstones themselves) removed. */
export function readLiveMemory(personaPath: string): MemoryEntry[] {
  const all = readMemory(personaPath);
  const tombstoned = new Set<string>();
  for (const e of all) {
    const t = e.tags.find((x) => x.startsWith("target:"));
    if (e.tags.includes("tombstone") && t) tombstoned.add(t.slice("target:".length));
  }
  return all.filter((e) => !e.tags.includes("tombstone") && !tombstoned.has(e.hash));
}

/**
 * Consolidate episodic memory into a semantic snapshot at <personaDir>/memory.md
 * (the spec's `memory.types.semantic`). Deterministic + dependency-free: groups
 * live (non-tombstoned) entries by provenance source into a digest. Idempotent —
 * rewritten each call, so it always reflects the current live memory.
 */
export function consolidateSemantic(personaPath: string, limit = 200): { ok: boolean; path: string; count: number } {
  const entries = readLiveMemory(personaPath).slice(-limit);
  const path = join(dirname(personaPath), "memory.md");
  if (entries.length === 0) {
    writeFileSync(path, "# Semantic memory\n\n_(empty)_\n", "utf-8");
    return { ok: true, path, count: 0 };
  }
  const bySource = new Map<string, MemoryEntry[]>();
  for (const e of entries) {
    const arr = bySource.get(e.source) ?? [];
    arr.push(e);
    bySource.set(e.source, arr);
  }
  const lines = ["# Semantic memory (consolidated)", "", `_generated ${new Date().toISOString()} from ${entries.length} episodic entr${entries.length === 1 ? "y" : "ies"}_`, ""];
  for (const [source, arr] of bySource) {
    lines.push(`## From ${source}`);
    for (const e of arr) lines.push(`- ${e.content.replace(/\n+/g, " ").trim()} \`#${e.hash.slice(0, 8)}\``);
    lines.push("");
  }
  writeFileSync(path, lines.join("\n"), "utf-8");
  return { ok: true, path, count: entries.length };
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
