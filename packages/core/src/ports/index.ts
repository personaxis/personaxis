/**
 * F3.3, storage ports (the hexagonal seam, "only where it hurts": persistence).
 *
 * The engine's spec-faithful logic, clamp+audit mutation, the governance gate,
 * the hash-chained ledger, the Living Loop, is pure and unchanged. What varies
 * between a local CLI and the managed SaaS is only WHERE bytes live: the local
 * default is a git-versionable persona folder (atomic writes + a per-persona
 * lock); the SaaS is Postgres/S3 over the SAME engine. These ports are that
 * boundary, and `defaultFsStorage()` is the reference (filesystem) adapter.
 *
 * Ports (each keyed by the persona's path/id so one engine can host many):
 *   - LockProvider, serialize read→modify→write (same-machine default; a
 *                     distributed lock in the SaaS);
 *   - StateStore, state.json (the runtime checkpoint);
 *   - MemoryStore, semantic memory (memory.md) + consolidation;
 *   - LedgerStore, the append-only, hash-chained EPISODIC ledger
 *                     (tamper-evident; append + read + verify + redact);
 *   - ModelClient, the LLM call the compiler/appraiser makes (the SaaS
 *                     injects its hosted model; the loop's appraiser is the
 *                     existing model seam and stays injectable separately).
 */

import type { StateFile } from "../persona.js";
import type { MemoryEntry } from "../memory.js";
import {
  readState,
  writeState,
  stateExists,
} from "../persona.js";
import { withStateLock } from "../lock.js";
import {
  readMemory,
  commitMemoryEntry,
  verifyMemoryChain,
  redactMemory,
  readSemanticMemory,
  consolidateSemantic,
} from "../memory.js";

export interface LockProvider {
  /** Run `fn` while holding the exclusive lock for `key` (a persona's state path). */
  withLock<T>(key: string, fn: () => T): T;
}

export interface StateStore {
  read(key: string): StateFile;
  write(key: string, state: StateFile): void;
  exists(key: string): boolean;
}

export interface MemoryStore {
  /** The curated long-term semantic memory (memory.md) as text. */
  readSemantic(key: string): string;
  /** Consolidate recent episodic entries into semantic memory. */
  consolidate(key: string, limit?: number): { ok: boolean; path: string; count: number };
}

export interface ChainVerification {
  ok: boolean;
  brokenAt?: number;
}

export interface LedgerStore {
  /** All episodic entries (the hash-chained ledger), oldest→newest. */
  read(key: string): MemoryEntry[];
  /** Append one entry, extending the hash chain. */
  append(key: string, entry: MemoryEntry): void;
  /** Verify the chain is intact (tamper-evidence). */
  verify(key: string): ChainVerification;
  /** Erase an entry's content while keeping the chain verifiable (right-to-delete). */
  redact(key: string, id: string, reason: string): { redacted: boolean };
}

export interface ModelCompletion {
  text: string;
  model: string;
}

export interface ModelClient {
  complete(prompt: string, opts?: { timeoutMs?: number }): Promise<ModelCompletion>;
}

/** The full storage bundle an engine host can inject. `model` is optional. */
export interface Storage {
  lock: LockProvider;
  state: StateStore;
  memory: MemoryStore;
  ledger: LedgerStore;
  model?: ModelClient;
}

// ── default filesystem adapters (the reference implementation) ──────────────────

export const fsLockProvider: LockProvider = {
  withLock: (key, fn) => withStateLock(key, fn),
};

export const fsStateStore: StateStore = {
  read: (key) => readState(key),
  write: (key, state) => writeState(key, state),
  exists: (key) => stateExists(key),
};

export const fsMemoryStore: MemoryStore = {
  readSemantic: (key) => readSemanticMemory(key),
  consolidate: (key, limit) => consolidateSemantic(key, limit),
};

export const fsLedgerStore: LedgerStore = {
  read: (key) => readMemory(key),
  append: (key, entry) => commitMemoryEntry(key, entry),
  verify: (key) => verifyMemoryChain(key),
  redact: (key, id, reason) => {
    redactMemory(key, id, reason); // returns the redacted+audit entries or throws
    return { redacted: true };
  },
};

/** The default filesystem storage bundle (git-versionable persona folder). */
export function defaultFsStorage(): Storage {
  return { lock: fsLockProvider, state: fsStateStore, memory: fsMemoryStore, ledger: fsLedgerStore };
}
