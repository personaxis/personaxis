/**
 * Per-persona state lock, same-machine concurrency control (F1.4 / ADR-009).
 *
 * Multiple processes write a persona's state.json by design (REPL + serve + watch +
 * MCP + hooks). Without a lock, read→modify→write races lose mutation_log entries, 
 * unacceptable for a governed, audited runtime.
 *
 * Mechanism: a lock DIRECTORY next to the file (`state.json.lock/`), holding an
 * `owner.json` of {pid, ts}. The directory is built BESIDE and renamed into place, so
 * it never exists without its owner inside it: a rename is atomic, and the two-step
 * "mkdir then write the owner" it replaced left a window a waiter read as a crashed
 * holder. A lock is stale (stealable) when its owner process is dead or its timestamp
 * is older than STALE_MS (a holder never legitimately holds it that long: locks wrap
 * only the mechanical read→apply→write section, never a model call). Waiters retry
 * with a short sync sleep up to WAIT_TIMEOUT_MS, then fail loudly, silent
 * lock-skipping would defeat the audit guarantee.
 *
 * This does NOT solve cross-machine sync (that is sync.ts's job), only same-machine.
 */

import { mkdirSync, renameSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";

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
  // No owner means genuinely broken now, and it did not used to. While the lock was
  // created empty and filled in afterwards, this branch also fired on an ordinary
  // holder caught mid-write, which is how a waiter came to delete a live lock. With
  // the directory renamed into place there is no such moment: an owner-less lock dir
  // is one somebody interrupted between two syscalls, and stealing it is right.
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
    // Built beside and MOVED into place, never created empty and filled in.
    //
    // This is a fix, and the race it closes was measured rather than reasoned about:
    // six real processes appending to one persona's memory, and one of them failing
    // outright in roughly one run in six. `mkdir` then `writeFile` leaves a window in
    // which the directory exists with no `owner.json` inside it, and a waiter that
    // looks in that window reads "no owner" as "the holder crashed", steals the lock
    // and deletes the directory the holder is still using. The holder's own write of
    // `owner.json` then lands on a path that is gone, throws, and the process dies
    // having done nothing, which is exactly what the flake was.
    //
    // A rename of a directory is atomic, so `lockDir` never exists without its owner
    // inside it, and the steal rule below can only ever fire on a genuinely broken
    // one. It is the same reasoning the device credential and the in-flight file use
    // one package over: a partial file is a state somebody will read.
    const staging = `${lockDir}.${process.pid}.${Math.random().toString(36).slice(2, 10)}`;
    const mine = { pid: process.pid, ts: Date.now() };
    try {
      // NOT recursive, and a test in `cli` caught me making it so. `recursive: true`
      // creates missing parents, so locking a path inside a directory that does not
      // exist quietly succeeded and built the tree on the way: a compaction aimed at a
      // persona that is not there stopped reporting a problem and started reporting
      // success. A lock is not the thing that decides a directory should exist.
      mkdirSync(staging);
      writeFileSync(`${staging}/owner.json`, JSON.stringify(mine), "utf-8");
      renameSync(staging, lockDir);
      return () => releaseIfStillOurs(lockDir, mine);
    } catch (err) {
      rmSync(staging, { recursive: true, force: true });
      const code = (err as NodeJS.ErrnoException).code;
      // A directory rename onto an existing directory fails differently across
      // platforms, and every one of these means the same thing: somebody else holds
      // it. Listing them beats treating anything but EEXIST as fatal, which on Windows
      // would have turned ordinary contention into a crash.
      if (code !== "EEXIST" && code !== "ENOTEMPTY" && code !== "EPERM" && code !== "EACCES") {
        throw err;
      }
      if (isStale(lockDir)) {
        rmSync(lockDir, { recursive: true, force: true });
        continue; // retry immediately
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

/**
 * Give the lock back, and only if it is still the one we took.
 *
 * A release that removed whatever directory happens to be there would delete a lock
 * somebody else legitimately took after ours was declared stale, and the second holder
 * would carry on believing it was alone. Rare, and the whole point of a lock is the
 * rare case.
 */
function releaseIfStillOurs(lockDir: string, mine: LockOwner): void {
  const owner = readOwner(lockDir);
  if (owner && (owner.pid !== mine.pid || owner.ts !== mine.ts)) return;
  rmSync(lockDir, { recursive: true, force: true });
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
