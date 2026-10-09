/**
 * The command table is what `index.ts` loads from, one command at a time. An entry whose names drift from what
 * the loaded command answers to would send `personaxis <name>` to the root REPL instead of the command, so each
 * entry is held to the real command's name and aliases.
 */
import { describe, it, expect } from "vitest";

import { COMMAND_TABLE, entriesFor } from "../src/command-table.js";

describe("command table", () => {
  it("names each command exactly as the loaded command answers to it", async () => {
    for (const entry of COMMAND_TABLE) {
      const command = await entry.load();
      expect([command.name(), ...command.aliases()]).toEqual(entry.names);
    }
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
