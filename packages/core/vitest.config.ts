import { defineConfig } from "vitest/config";

// The property suites (PB-T1..T6, fast-check) run synchronous, CPU-heavy loops
// that block a worker's event loop. In the default `threads` pool that block
// starves vitest's MessagePort worker-RPC and trips "Timeout calling
// onTaskUpdate" on slower CI runners, failing the run even with every test
// green. The `forks` pool talks over process IPC (no such RPC timeout), so it is
// robust under these long synchronous blocks.
export default defineConfig({
  test: {
    pool: "forks",
  },
});
