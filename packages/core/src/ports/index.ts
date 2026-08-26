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
import { acquireStateLock } from "../lock.js";
import { fileRecordStorage, type RecordStorage } from "../record/store.js";
import {
  readMemory,
  commitMemoryEntry,
  verifyMemoryChain,
  redactMemory,
  readSemanticMemory,
  consolidateSemantic,
} from "../memory.js";

export interface LockProvider {
  /**
   * Take the exclusive lock for `key` (a persona's state path) and return its release.
   *
   * Acquire-and-release rather than `withLock(key, fn)`, and the change was forced by
   * a real hazard rather than taste. `withLock` is generic over what the callback
   * returns, so handing it an async function type-checks and releases the lock the
   * moment the promise is CREATED. Everything after the first await then runs
   * unprotected, and a persona's read, mutate and print is entirely after the first
   * await. A lock held only until the first await looks like protection in the code
   * and provides none.
   */
  acquire(key: string): () => void;
}

/**
 * Hold a lock across a synchronous body. Safe only because `fn` cannot await.
 *
 * Kept as a helper on top of `acquire` rather than as a method on the port, so
 * nothing can implement the dangerous shape.
 */
export function withHeld<T>(lock: LockProvider, key: string, fn: () => T): T {
  const release = lock.acquire(key);
  try {
    return fn();
  } finally {
    release();
  }
}

export interface StateStore {
  read(key: string): StateFile;
  write(key: string, state: StateFile): void;
  exists(key: string): boolean;
}

/**
 * Where a persona's record lives: the entries themselves, not a file of them.
 *
 * The seam had to move down a level once the record became the source. `StateStore`
 * is a port over a document that is now printed rather than kept, so a hosted engine
 * given only that port would be hosting the projection and losing the thing it is
 * projected from. This is the same boundary at the level the truth is at.
 *
 * One declaration, in the module that knows what a record needs, rather than a
 * second one here that could drift from it.
 */
export type RecordStore = RecordStorage;

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
  /**
   * Optional while `state.json` is still written beside it. R8 is what makes this
   * the only one of the two that matters, and the default is the filesystem so an
   * adapter written before this existed keeps working.
   */
  record?: RecordStore;
  memory: MemoryStore;
  ledger: LedgerStore;
  model?: ModelClient;
}

// ── default filesystem adapters (the reference implementation) ──────────────────

export const fsLockProvider: LockProvider = {
  acquire: (key) => acquireStateLock(key),
};

export const fsRecordStore: RecordStore = fileRecordStorage;

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
  return {
    lock: fsLockProvider,
    state: fsStateStore,
    record: fsRecordStore,
    memory: fsMemoryStore,
    ledger: fsLedgerStore,
  };
}

// F2: where an ALLOWED action happens. Separate from the storage ports above because it
// answers a different question (this machine or a container the workspace started), and
// because it is emphatically not a security boundary: gating happens before it.
export * from "./execution.js";
