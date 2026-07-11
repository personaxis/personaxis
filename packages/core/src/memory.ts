/**
 * Governed episodic memory, bounded, provenance-tagged, append-only, auditable.
 *
 * The research is unambiguous:
 * once untrusted content reaches long-term memory it persists and is later
 * retrieved as "trusted" context, the Zombie-Agent / memory-poisoning failure
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
 * are authoritative, a persona with `episodic: false` writes nothing to the log.
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
  /**
   * v1.0: sha256 of `content`. The chain hash commits to THIS, not to the
   * content bytes, so `content` can be REDACTED (real erasure, D6/GDPR) while
   * the chain stays verifiable. Absent on legacy (≤0.10) entries, whose chain
   * hash commits to the content directly (redaction there breaks the chain;
   * re-anchor with migrateMemoryChain first).
   */
  content_hash?: string;
  /** v1.0: true when `content` was erased by redactMemory (content_hash retained). */
  redacted?: boolean;
  /** Hash of the previous entry (lineage chain); "" for the first. */
  prev_hash: string;
  /** v1.0: sha256 over {ts, content_hash, source, tags, prev_hash}. Legacy: over {ts, content, …}. */
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

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** LEGACY (≤0.10) chain hash: commits to the content bytes directly. */
function hashEntryLegacy(e: Pick<MemoryEntry, "ts" | "content" | "source" | "tags" | "prev_hash">): string {
  return sha256(
    JSON.stringify({ ts: e.ts, content: e.content, source: e.source, tags: e.tags, prev_hash: e.prev_hash }),
  );
}

/** v1.0 chain hash: commits to content_hash, enabling erasure without a chain break. */
function hashEntryV1(e: Pick<MemoryEntry, "ts" | "content_hash" | "source" | "tags" | "prev_hash">): string {
  return sha256(
    JSON.stringify({ ts: e.ts, content_hash: e.content_hash, source: e.source, tags: e.tags, prev_hash: e.prev_hash }),
  );
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

/** Build (but do not write) the next entry, the dry-run half of write-path audit.
 * New entries are always v1.0 format (content_hash-anchored: erasure-capable). */
export function prepareMemoryEntry(
  personaPath: string,
  req: MemoryWriteRequest,
): MemoryEntry {
  const base: Omit<MemoryEntry, "hash"> = {
    ts: new Date().toISOString(),
    content: req.content,
    source: req.source,
    tags: req.tags ?? [],
    content_hash: sha256(req.content),
    prev_hash: lastHash(personaPath),
  };
  return { ...base, hash: hashEntryV1(base) };
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
 * deletion itself is thus auditable, you can prove what was removed and when.
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
 * live (non-tombstoned) entries by provenance source into a digest. Idempotent, 
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

/**
 * Outcome label for an agent run. The run summary is recorded as an EPISODIC
 * memory entry (source: "synthesis", tag: "agent-run"), no separate STATE.md /
 * agent-state log: the spec's memory.md (consolidated) + episodic + state.json's
 * agent_session already cover task resumption.
 */
export type AgentOutcome = "success" | "denied" | "error" | "verification_failed" | "stopped";

/** Read the consolidated semantic memory (memory.md), if present. */
export function readSemanticMemory(personaPath: string): string {
  const p = join(dirname(personaPath), "memory.md");
  return existsSync(p) ? readFileSync(p, "utf-8") : "";
}

/**
 * Verify the hash chain is intact (tamper / poisoning detection). Each entry is
 * verified per its own format: v1.0 entries (content_hash present) recompute the
 * chain hash over content_hash AND, unless redacted, check the content still
 * matches its content_hash; legacy entries recompute over the content directly.
 */
export function verifyMemoryChain(personaPath: string): { ok: boolean; brokenAt?: number } {
  const entries = readMemory(personaPath);
  let prev = "";
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.prev_hash !== prev) return { ok: false, brokenAt: i };
    if (typeof e.content_hash === "string") {
      if (hashEntryV1(e) !== e.hash) return { ok: false, brokenAt: i };
      if (!e.redacted && sha256(e.content) !== e.content_hash) return { ok: false, brokenAt: i };
    } else {
      if (hashEntryLegacy(e) !== e.hash) return { ok: false, brokenAt: i };
    }
    prev = e.hash;
  }
  return { ok: true };
}

const REDACTION_MARKER = "[redacted]";

/**
 * REAL erasure (v1.0, D6): remove the content bytes of a prior entry while the
 * chain stays verifiable, the chain hash commits to content_hash, which is
 * retained. This is the ONLY sanctioned rewrite of a prior line, it is
 * irreversible, and it is itself audited (a `redaction` record is appended).
 * Complements tombstoneMemory (which hides but retains bytes): tombstone for
 * retrieval removal, redact for right-to-erasure.
 */
export function redactMemory(
  personaPath: string,
  targetHash: string,
  reason: string,
): { redacted: MemoryEntry; audit: MemoryEntry } {
  const p = memoryPath(personaPath);
  const entries = readMemory(personaPath);
  const idx = entries.findIndex((e) => e.hash === targetHash);
  if (idx === -1) throw new Error(`no memory entry with hash ${targetHash}`);
  const target = entries[idx];
  if (typeof target.content_hash !== "string") {
    throw new Error(
      `entry ${targetHash.slice(0, 8)} is legacy format (chain hash commits to its content); ` +
        `run migrateMemoryChain() to re-anchor the log before redacting`,
    );
  }
  entries[idx] = { ...target, content: REDACTION_MARKER, redacted: true };
  writeFileSync(p, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
  const audit = tombstoneMemory(personaPath, targetHash, `redacted: ${reason}`);
  return { redacted: entries[idx], audit };
}

/**
 * Re-anchor a legacy (≤0.10) episodic log to the v1.0 content_hash format so its
 * entries become redactable. Rewrites every line: adds content_hash, recomputes
 * each chain hash, re-links prev_hash, and remaps tombstone `target:` tags to
 * the new hashes. One-time, deliberate migration, the old hashes are replaced.
 */
export function migrateMemoryChain(personaPath: string): { migrated: number; remapped: Record<string, string> } {
  const p = memoryPath(personaPath);
  const entries = readMemory(personaPath);
  if (entries.length === 0) return { migrated: 0, remapped: {} };
  const remapped: Record<string, string> = {};
  let prev = "";
  const next: MemoryEntry[] = [];
  for (const e of entries) {
    const base: Omit<MemoryEntry, "hash"> = {
      ts: e.ts,
      content: e.content,
      source: e.source,
      // Remap tombstone target tags to the already-migrated hash of their target.
      tags: e.tags.map((t) =>
        t.startsWith("target:") && remapped[t.slice("target:".length)]
          ? `target:${remapped[t.slice("target:".length)]}`
          : t,
      ),
      content_hash: e.content_hash ?? sha256(e.content),
      redacted: e.redacted,
      prev_hash: prev,
    };
    if (base.redacted === undefined) delete (base as Record<string, unknown>).redacted;
    const migrated: MemoryEntry = { ...base, hash: hashEntryV1(base) };
    remapped[e.hash] = migrated.hash;
    prev = migrated.hash;
    next.push(migrated);
  }
  writeFileSync(p, next.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
  return { migrated: next.length, remapped };
}
