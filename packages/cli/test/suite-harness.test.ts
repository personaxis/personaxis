/**
 * E29: a ratchet on the test harness itself.
 *
 * This suite used to exit non-zero with all 989 tests green, about one run in four,
 * because vitest's default fork count (`cpus - 1`) plus the node processes the e2e
 * tests spawn starved the main thread until a worker's RPC hit its 60s ceiling. The
 * fix is in vitest.config.ts and it is one line, which is exactly the kind of line
 * that gets deleted during an unrelated cleanup by someone who has never seen the
 * failure. So it is asserted here, with the reason attached.
 *
 * This tests the instrument, not the subject, and that is deliberate: a suite whose
 * exit code is unreliable makes every other measurement in this repo unreliable too.
 */
import { describe, it, expect } from "vitest";
import { cpus } from "node:os";
import config from "../vitest.config.js";

describe("the test harness does not lie about its own result (E29)", () => {
  it("caps workers so the main thread keeps enough CPU to answer its workers", () => {
    const maxWorkers = config.test?.maxWorkers;
    expect(maxWorkers, "vitest.config.ts must cap maxWorkers; see E29").toBeTypeOf("number");

    // Half the cores, because the fork count knows nothing about the processes the
    // e2e tests spawn underneath each worker.
    const cores = cpus().length || 4;
    expect(maxWorkers as number).toBeLessThanOrEqual(Math.max(2, Math.floor(cores / 2)));
    expect(maxWorkers as number).toBeGreaterThanOrEqual(2);
  });
});
