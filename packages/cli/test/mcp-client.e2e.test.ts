import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "dist", "index.js");
const built = existsSync(CLI);

function run(args: string[], cwd: string): string {
  return execFileSync("node", [CLI, ...args], {
    encoding: "utf-8",
    cwd,
    env: { ...process.env, FORCE_COLOR: "0", PERSONAXIS_NO_UPDATE_CHECK: "1" },
  });
}

describe.skipIf(!built)("personaxis mcp client (V2-F3.B11)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pxs-mcp-"));
  });

  it("adds, lists, and removes an MCP server in the project config", { timeout: 90_000 }, () => {
    expect(run(["mcp", "add", "fs", "mycmd", "a", "b"], dir)).toContain("added");
    const listed = run(["mcp", "list"], dir);
    expect(listed).toContain("fs");
    expect(listed).toContain("mycmd a b");
    expect(run(["mcp", "rm", "fs"], dir)).toContain("removed");
    expect(run(["mcp", "list"], dir)).toContain("no MCP servers");
  });
});
