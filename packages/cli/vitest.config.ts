import { defineConfig } from "vitest/config";

import { coverage } from "../../vitest.floor";

export default defineConfig({
  test: {
    // V5.FIX.1: every worker gets a throwaway PERSONAXIS_HOME before any test
    // module loads, so the suite can never read or clobber the real ~/.personaxis
    // (see test/setup-home.ts for the incident this prevents).
    setupFiles: ["./test/setup-home.ts"],
    coverage: coverage("cli"),
  },
});
