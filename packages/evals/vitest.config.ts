import { defineConfig } from "vitest/config";

import { coverage } from "../../vitest.floor";

// The governance suite CI runs on every push.
// The floor lives in vitest.floor.ts, with every package's number in one column.
export default defineConfig({
  test: {
    coverage: coverage("evals"),
  },
});
