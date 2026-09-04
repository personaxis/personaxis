import { cpus } from "node:os";
import { defineConfig } from "vitest/config";

import { coverage } from "../../vitest.floor";

/**
 * E29: this package's suite used to exit non-zero with every one of its 989 tests
 * green, roughly one run in four. The failure was never an assertion:
 *
 *   [vitest-worker]: Timeout calling "onTaskUpdate"
 *
 * That is birpc's 60s ceiling on a worker waiting for the main thread to acknowledge
 * a progress update, and this suite runs for ~61s. For a single call to wait the whole
 * 60s, the main thread has to be starved for essentially the entire run.
 *
 * It is: vitest defaults to `cpus - 1` forks (19 here), and eight of these files are
 * e2e tests that spawn the built CLI as further node processes. Twenty cores are asked
 * to run nineteen workers plus their children plus the main thread, so the thread that
 * answers the RPC is the one that loses.
 *
 * Measured, on this machine, before any change: 3 failures in 11 runs with the default
 * reporter, under both pnpm and npx. Splitting e2e from unit tests does not help, they
 * are 38s and 52s on their own and the ceiling is 60s either way. Raising the RPC
 * timeout would be the E27 mistake again: a ceiling raised is permission, not a fix.
 *
 * So: stop oversubscribing. Half the cores leaves room for the processes the e2e tests
 * spawn, which the fork count does not know about. Costs ~11% wall time (61s to ~68s)
 * and buys a suite whose exit code means what it says.
 */
const HALF_THE_CORES = Math.max(2, Math.floor((cpus().length || 4) / 2));

export default defineConfig({
  test: {
    // V5.FIX.1: every worker gets a throwaway PERSONAXIS_HOME before any test
    // module loads, so the suite can never read or clobber the real ~/.personaxis
    // (see test/setup-home.ts for the incident this prevents).
    setupFiles: ["./test/setup-home.ts"],
    maxWorkers: HALF_THE_CORES,
    coverage: coverage("cli"),
  },
});
