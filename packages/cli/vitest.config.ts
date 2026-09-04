import { cpus } from "node:os";
import { defineConfig } from "vitest/config";

import { coverage } from "../../vitest.floor";

/**
 * E29: this package's suite can exit non-zero with every one of its 994 tests green.
 * The failure is never an assertion:
 *
 *   [vitest-worker]: Timeout calling "onTaskUpdate"
 *
 * That is birpc's 60s ceiling on a worker waiting for the main thread to acknowledge a
 * progress update. **The mechanism written here before was wrong**, and it is worth
 * saying so rather than quietly replacing it: it claimed the main thread was starved of
 * CPU by oversubscription and lost the race to answer. Measured with
 * `monitorEventLoopDelay` inside vitest's own main process, during three runs that
 * failed, the worst event loop delay was **123ms, 182ms and 199ms**. A thread that turns
 * that often is answering. The starvation account is refuted.
 *
 * What was ruled out with it, each by measurement rather than by reasoning:
 *
 * The REPORTER does nothing. Default against `dot`, four runs each, interleaved: 33.6s
 * and 33.4s head to head, zero errors either way. An earlier reading that blamed the
 * package manager was this same variable misread, and it is now closed.
 *
 * FAKE TIMERS are not it either, which is a shame because they fit beautifully: one file
 * in this suite advances a virtual clock 75 seconds, past the RPC's own 60s ceiling.
 * Running the suite without that file still produced errors in two runs of three, and
 * running that file alone produced none in six.
 *
 * A LEAKED TIMER is not it. birpc calls `clearTimeout` on reply, and on this Node
 * `setTimeout(...).unref()` returns the Timeout, so the clear lands. A timeout means no
 * reply arrived, not that a timer was forgotten.
 *
 * What survives is narrower and is not ours to fix: a small share of `onTaskUpdate`
 * calls go unanswered, and they only become visible when the run outlives the 60s timer.
 * Two conditions have to hold together, and either one alone is not enough. Over about
 * sixty seconds of wall time: fourteen runs under 65s produced zero errors, and runs at
 * 73s, 78s, 88s, 94s and 119s produced 1, 1, 3, 2 and 5. AND enough workers talking at
 * once: the same suite at 88s with two workers produced zero.
 *
 * So half the cores stays, and now for the reason it actually earns. It is FASTER, which
 * is what keeps a run under the ceiling: measured interleaved, three rounds each, 31.2s
 * against 34.1s for vitest's default of `cores - 1`. And it holds concurrency down,
 * which is the second condition, and it holds it down hardest on the small machines
 * where a run is slowest.
 *
 * Two things deliberately NOT done. The RPC timeout is not raised, which is the E27
 * lesson: a ceiling raised is permission, not a fix. And unhandled errors are not
 * ignored, because the switch that would hide this one hides the real ones too.
 *
 * The `threads` pool would use a different transport and answer where the reply is lost.
 * It is not an option here: 22 tests fail under it.
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
