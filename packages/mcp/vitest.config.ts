import { defineConfig } from "vitest/config";

import { coverage } from "../../vitest.floor";

// The MCP server: tool definitions and the transport around them.
// The floor lives in vitest.floor.ts, with every package's number in one column.
export default defineConfig({
  test: {
    coverage: coverage("mcp"),
  },
});
