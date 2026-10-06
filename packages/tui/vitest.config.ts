import { defineConfig } from "vitest/config";

import { coverage } from "../../vitest.floor";

export default defineConfig({
  test: {
    // The TUI suite asserts on exact frames, so animation must be off and the
    // input-arming delay (V7.A4, which drains stray keystrokes on a real terminal)
    // must not apply: a test's stdin has no stray buffer to drain.
    env: { PERSONAXIS_NO_ANIM: "1" },
    coverage: coverage("tui"),
  },
});
