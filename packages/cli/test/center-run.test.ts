/**
 * V9 / G.4b: the host's edit action actually mutates the persona through the SDK. A field edit
 * from the navigator becomes an envelope-clamped `adjust`, keyed to the node's own persona path.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { readState } from "@personaxis/core";
import { writeStarterPersona } from "../src/starter.js";
import { personaTree, type ScopeNode } from "../src/center/tree.js";
import { applyNavigatorEdit } from "../src/center/run.js";

let dir: string;
let mainPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pxs-run-"));
  mainPath = writeStarterPersona(dir, "Vega");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** The first editable (direct) field node in the persona's layers. */
function firstEditableField(): ScopeNode {
  const layers = personaTree(mainPath, "").children().find((c) => c.id === "layers")!;
  const fields = layers.children().flatMap((l) => l.children());
  return fields.find((f) => f.actions.some((a) => a.effect === "direct"))!;
}

describe("navigator edit execution (G.4b)", () => {
  it("carries the persona path on a field node, so the host can route the edit", () => {
    const field = firstEditableField();
    expect(field.personaPath).toBe(mainPath);
  });

  it("applies a field edit as an envelope-clamped mutation to state.json", () => {
    const field = firstEditableField();
    const statePath = join(dirname(mainPath), "state.json");

    applyNavigatorEdit(field, field.actions[0], "0.50");

    const st = readState(statePath) as { values?: Record<string, number> } | null;
    expect(st?.values, "the edit wrote a state value").toBeDefined();
    expect(typeof st!.values![field.id], `${field.id} is now a number`).toBe("number");
  });

  it("ignores a non-numeric value rather than guessing", () => {
    const field = firstEditableField();
    const statePath = join(dirname(mainPath), "state.json");
    expect(() => applyNavigatorEdit(field, field.actions[0], "not-a-number")).not.toThrow();
    // A bogus entry writes nothing: no mutation, so no state file was created.
    expect(existsSync(statePath)).toBe(false);
  });
});
