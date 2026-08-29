import { defineConfig } from "vitest/config";

import { coverage } from "../../vitest.floor";

// The published surface a third party imports.
// The floor lives in vitest.floor.ts, with every package's number in one column.
export default defineConfig({
  test: {
    coverage: coverage("sdk"),
  },
});
