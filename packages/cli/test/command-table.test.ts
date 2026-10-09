/**
 * The command table is what `index.ts` loads from, one command at a time. An entry whose names drift from what
 * the loaded command answers to would send `personaxis <name>` to the root REPL instead of the command, so each
 * entry is held to the real command's name and aliases.
 *
 * The commands are loaded in a child process from the build, like every other command test: imported here they
 * would all count toward the in-process coverage floor as code nothing ran, which measures the import, not the
 * commands.
 */
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { COMMAND_TABLE, entriesFor } from "../src/command-table.js";
import { runCli } from "./helpers/fake-model.js";

const TABLE = pathToFileURL(join(process.cwd(), "dist", "command-table.js")).href;

describe("command table", () => {
  it("names each command exactly as the loaded command answers to it", { timeout: 60_000 }, async () => {
    const script = `const { COMMAND_TABLE } = await import(${JSON.stringify(TABLE)});
const rows = [];
for (const entry of COMMAND_TABLE) {
  const command = await entry.load();
  rows.push({ names: entry.names, actual: [command.name(), ...command.aliases()] });
}
console.log(JSON.stringify(rows));`;
    const run = await runCli("--input-type=module", ["-e", script]);
    expect(run.code, run.stderr).toBe(0);
    const rows = JSON.parse(run.stdout) as Array<{ names: string[]; actual: string[] }>;
    expect(rows).toHaveLength(COMMAND_TABLE.length);
    for (const row of rows) expect(row.actual).toEqual(row.names);
  });

  it("names no command twice", () => {
    const names = COMMAND_TABLE.flatMap((entry) => entry.names);
    expect(new Set(names).size).toBe(names.length);
  });

  it("loads only the command asked for, none for the REPL, and all for help or an unknown word", () => {
    expect(entriesFor(["validate", "--strict"]).map((entry) => entry.names[0])).toEqual(["validate"]);
    expect(entriesFor(["login"]).map((entry) => entry.names[0])).toEqual(["connect"]);
    expect(entriesFor([])).toEqual([]);
    expect(entriesFor(["-p", "hello"])).toEqual([]);
    expect(entriesFor(["--version"])).toEqual([]);
    expect(entriesFor(["--help"])).toBe(COMMAND_TABLE);
    expect(entriesFor(["valdate"])).toBe(COMMAND_TABLE);
  });
});
