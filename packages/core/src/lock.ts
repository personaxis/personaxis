/**
 * Per-persona state lock, same-machine concurrency control (F1.4 / ADR-009).
 *
 * Multiple processes write a persona's state.json by design (REPL + serve + watch +
 * MCP + hooks). Without a lock, read→modify→write races lose mutation_log entries, 
 * unacceptable for a governed, audited runtime.
 *
 * Mechanism: a lock DIRECTORY next to the file (`state.json.lock/`). mkdir is atomic
 * on every OS/filesystem we target; the holder records `owner.json` {pid, ts}. A lock
 * is stale (stealable) when its owner process is dead or its timestamp is older than
 * STALE_MS (a holder never legitimately holds it that long: locks wrap only the
 * mechanical read→apply→write section, never a model call). Waiters retry with a
 * short sync sleep up to WAIT_TIMEOUT_MS, then fail loudly, silent lock-skipping
 * would defeat the audit guarantee.
 *
 * This does NOT solve cross-machine sync (that is sync.ts's job), only same-machine.
 */

import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";

const STALE_MS = 10_000;
const WAIT_TIMEOUT_MS = 5_000;
const RETRY_SLEEP_MS = 25;

interface LockOwner {
  pid: number;
  ts: number;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readOwner(lockDir: string): LockOwner | undefined {
  try {
    return JSON.parse(readFileSync(`${lockDir}/owner.json`, "utf-8")) as LockOwner;
  } catch {
    return undefined;
  }
}

function isStale(lockDir: string): boolean {
  const owner = readOwner(lockDir);
  // Unreadable/missing owner right after mkdir can be a holder mid-write; only
  // treat as stale once the dir itself has been around longer than STALE_MS is
  // unknowable without the owner file, fall back to "steal" (the dir with no
  // owner.json for a full retry cycle is a crashed holder).
  if (!owner) return true;
  if (!pidAlive(owner.pid)) return true;
  return Date.now() - owner.ts > STALE_MS;
}

/**
 * Acquire the lock for `targetPath` (e.g. a state.json), returning a release fn.
 * Prefer `withStateLock`, it guarantees release.
 */
export function acquireStateLock(targetPath: string): () => void {
  const lockDir = `${targetPath}.lock`;
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      mkdirSync(lockDir);
      writeFileSync(`${lockDir}/owner.json`, JSON.stringify({ pid: process.pid, ts: Date.now() }), "utf-8");
      return () => rmSync(lockDir, { recursive: true, force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (isStale(lockDir)) {
        rmSync(lockDir, { recursive: true, force: true });
        continue; // retry mkdir immediately
      }
      if (Date.now() >= deadline) {
        const owner = readOwner(lockDir);
        throw new Error(
          `could not acquire state lock at ${lockDir} within ${WAIT_TIMEOUT_MS}ms ` +
            `(held by pid ${owner?.pid ?? "unknown"}). Another personaxis process is ` +
            `writing this persona; retry, or remove the lock dir if that process is gone.`,
        );
      }
      sleepSync(RETRY_SLEEP_MS);
    }
  }
}

/** Run `fn` holding the lock for `targetPath`. The lock is always released. */
export function withStateLock<T>(targetPath: string, fn: () => T): T {
  const release = acquireStateLock(targetPath);
  try {
    return fn();
  } finally {
    release();
  }
}

/** True if a live (non-stale) lock currently exists for `targetPath`. */
export function stateLockHeld(targetPath: string): boolean {
  const lockDir = `${targetPath}.lock`;
  return existsSync(lockDir) && !isStale(lockDir);
}
