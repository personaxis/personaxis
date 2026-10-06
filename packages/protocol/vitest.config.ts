import { defineConfig } from "vitest/config";

import { coverage } from "../../vitest.floor";

// Wire shapes. Nothing here talks to a machine, so it is all reachable.
// The floor lives in vitest.floor.ts, with every package's number in one column.
export default defineConfig({
  test: {
    coverage: coverage("protocol"),
  },
});
