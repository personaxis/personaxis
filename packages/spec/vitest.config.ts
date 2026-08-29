import { defineConfig } from "vitest/config";

import { coverage } from "../../vitest.floor";

// Schema package. The floor is low and honest; see vitest.floor.ts for why.
// The floor lives in vitest.floor.ts, with every package's number in one column.
export default defineConfig({
  test: {
    coverage: coverage("spec"),
  },
});
