import { availableParallelism } from "node:os";

import { defineConfig } from "vitest/config";

import { coverage } from "../../vitest.floor";

// The property suites (PB-T1..T6, fast-check) run synchronous, CPU-heavy loops
// that block a worker's event loop. In the default `threads` pool that block
// starves vitest's MessagePort worker-RPC and trips "Timeout calling
// onTaskUpdate" on slower CI runners, failing the run even with every test
// green. The `forks` pool talks over process IPC (no such RPC timeout), so it is
// robust under these long synchronous blocks.
export default defineConfig({
  test: {
    pool: "forks",
    // The property suites are CPU-bound for a minute at a time. `forks` stopped them
    // starving their OWN worker's RPC; it did not stop them starving the machine, so
    // an ordinary test in another worker would sit unscheduled and fail on a five
    // second clock while nothing was wrong with it. Two different files failed that
    // way on two consecutive runs of an otherwise green suite, which is the shape of a
    // suite people stop believing.
    //
    // A five second default is a claim that any test slower than that is broken, and
    // in this repo that claim is false: `PB-T3-decay` takes the best part of a minute
    // on purpose. Thirty seconds still catches a hang long before anybody waits it
    // out, and no healthy test here comes near it.
    testTimeout: 30_000,
    // And one core left alone, so the runner can always talk to its workers even while
    // every other core is inside a property loop.
    poolOptions: { forks: { maxForks: Math.max(1, (availableParallelism?.() ?? 4) - 1) } },
    // V5.FIX.1: hermetic PERSONAXIS_HOME per worker, before any test module
    // loads; no core test can ever read or clobber the real ~/.personaxis
    // (see test/setup-home.ts for the cli incident this prevents).
    setupFiles: ["./test/setup-home.ts"],
    coverage: coverage("core"),
  },
});
