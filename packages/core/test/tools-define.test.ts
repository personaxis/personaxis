/**
 * J.1: `defineTool` derives the handler's argument type from the JSON Schema, so the schema
 * stays the single source (FR.7) while handlers gain compile-time types.
 *
 * Two kinds of check: runtime (the produced ToolSpec behaves like a hand-written one and
 * validates against its own schema) and compile-time (`_typeProof` below would fail `tsc` if
 * the inference regressed; the `@ts-expect-error` proves a wrong access is actually rejected).
 */
import { describe, it, expect } from "vitest";
import { defineTool } from "../src/tools/define.js";
import { validateToolArgs } from "../src/tools/registry.js";
import { DEFAULT_POLICY } from "../src/sandbox.js";

const ALLOW = {
  decision: "allow" as const,
  reason: "test",
  class: { writesFiles: true, network: false, destructive: false, escapesWorkspace: false },
};

const sample = defineTool({
  name: "sample_write",
  description: "write text to a path",
  category: "fs",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      count: { type: "number" },
      mode: { type: "string", enum: ["append", "overwrite"] },
    },
    required: ["path", "count"],
    additionalProperties: false,
  },
  isReadOnly: false,
  isConcurrencySafe: false,
  gate: () => ALLOW,
  execute: async (args) => `wrote ${args.count} to ${args.path}${args.mode ? ` (${args.mode})` : ""}`,
});

describe("defineTool produces a normal ToolSpec (J.1)", () => {
  it("preserves name, category and the schema as the runtime source", () => {
    expect(sample.name).toBe("sample_write");
    expect(sample.category).toBe("fs");
    // The schema the model sees is exactly what was declared: it is still the single source.
    expect((sample.parameters as { properties: Record<string, unknown> }).properties.path).toEqual({ type: "string" });
  });

  it("validates args against its own schema, like any hand-written tool", () => {
    expect(validateToolArgs(sample, { path: "a.txt", count: 2 })).toEqual([]);
    expect(validateToolArgs(sample, { count: 2 })).toContain("missing required arg 'path'");
    expect(validateToolArgs(sample, { path: "a.txt", count: "two" })).toContain("arg 'count' must be number, got string");
    expect(validateToolArgs(sample, { path: "a.txt", count: 2, nope: 1 })).toContain("unknown arg 'nope'");
  });

  it("runs gate and execute with the (validated) args", async () => {
    expect(sample.gate({ path: "a.txt", count: 2 }, DEFAULT_POLICY).decision).toBe("allow");
    expect(await sample.execute({ path: "a.txt", count: 2, mode: "append" }, DEFAULT_POLICY)).toBe("wrote 2 to a.txt (append)");
  });
});

/**
 * Compile-time proof (never executed): if the derived types regressed, `tsc` (pnpm build)
 * would fail here, which is the real guarantee `defineTool` exists to provide.
 */
async function _typeProof(): Promise<void> {
  defineTool({
    name: "t",
    description: "",
    category: "meta",
    parameters: {
      type: "object",
      properties: { x: { type: "number" }, kind: { type: "string", enum: ["a", "b"] } },
      required: ["x"],
    },
    isReadOnly: true,
    isConcurrencySafe: true,
    gate: () => ALLOW,
    execute: async (args) => {
      const n: number = args.x; // required number
      const k: "a" | "b" | undefined = args.kind; // enum narrowed, optional
      // @ts-expect-error x is a number, not a string: the derived type must reject this
      const bad: string = args.x;
      return `${n}${k ?? ""}${bad}`;
    },
  });
}
void _typeProof;
