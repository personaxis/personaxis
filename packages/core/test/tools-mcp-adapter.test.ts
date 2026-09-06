/**
 * J.1c: an MCP server tool becomes a normal ToolSpec (category "mcp"), gated as an external
 * network action, with the transport injected so the mapping is testable without a server.
 */
import { describe, it, expect, vi } from "vitest";
import { mcpToolToSpec } from "../src/tools/mcp-adapter.js";
import { validateToolArgs } from "../src/tools/registry.js";
import { DEFAULT_POLICY } from "../src/sandbox.js";
import { noExecution } from "../src/ports/execution.js";

/** E32: the third argument is WHERE the action happens; this adapter must not act. */
const INERT = noExecution("this tool must not act");


const forecast = {
  name: "get_forecast",
  description: "Weather for a city",
  inputSchema: { type: "object", additionalProperties: false, required: ["city"], properties: { city: { type: "string" } } },
  annotations: { readOnlyHint: true, idempotentHint: true },
};

describe("mcpToolToSpec (J.1c)", () => {
  it("names it server:tool, categorizes it mcp, and passes the server schema through", () => {
    const spec = mcpToolToSpec("weather", forecast, async () => "");
    expect(spec.name).toBe("weather:get_forecast");
    expect(spec.category).toBe("mcp");
    expect(spec.isReadOnly).toBe(true);
    expect(spec.isConcurrencySafe).toBe(true); // read-only + idempotent
    expect(validateToolArgs(spec, { city: "Lima" })).toEqual([]);
    expect(validateToolArgs(spec, {})).toContain("missing required arg 'city'");
  });

  it("gates an external MCP call to ASK by default, ALLOW only under full access", () => {
    const spec = mcpToolToSpec("weather", forecast, async () => "");
    expect(spec.gate({ city: "Lima" }, DEFAULT_POLICY).decision).toBe("ask");
    expect(spec.gate({ city: "Lima" }, { ...DEFAULT_POLICY, sandbox: "danger-full-access" }).decision).toBe("allow");
  });

  it("relays execute to the injected transport with the UNPREFIXED tool name", async () => {
    const call = vi.fn(async (_name: string, _args: Record<string, unknown>) => "sunny, 22C");
    const spec = mcpToolToSpec("weather", forecast, call);
    expect(await spec.execute({ city: "Lima" }, DEFAULT_POLICY, INERT)).toBe("sunny, 22C");
    expect(call).toHaveBeenCalledWith("get_forecast", { city: "Lima" });
  });

  it("defaults conservatively when the server gives no hints: writer, serial", () => {
    const spec = mcpToolToSpec("db", { name: "run_query" }, async () => "");
    expect(spec.isReadOnly).toBe(false);
    expect(spec.isConcurrencySafe).toBe(false);
    expect(spec.name).toBe("db:run_query");
  });
});

/**
 * C1: the schemas an MCP server actually sends, which are not the flat ones the
 * built-ins declare.
 *
 * FR.7 keeps the BUILT-IN schemas flat and that decision stands: it is what lets
 * `defineTool` project a schema onto a handler type. But `mcpToolToSpec` passes a
 * third party's schema straight through, and `validateToolArgs` runs BEFORE the
 * gate, so anything it calls malformed never becomes a policy question at all.
 *
 * Every case here is ordinary. `integer` and `array` are in the first page of the
 * JSON Schema spec and in most MCP servers published today, and the only test
 * this adapter had used one string property.
 */
describe("an MCP schema that is not flat", () => {
  const spec = (properties: Record<string, unknown>, required: string[] = []) =>
    mcpToolToSpec(
      "srv",
      {
        name: "t",
        inputSchema: { type: "object", additionalProperties: false, required, properties },
      },
      async () => "",
    );

  it("accepts an integer, which is a JSON Schema type and not a JavaScript one", () => {
    expect(validateToolArgs(spec({ n: { type: "integer" } }), { n: 5 })).toEqual([]);
  });

  it("still refuses a number where an integer was asked for", () => {
    // Widening is not the fix. An integer property that took 2.5 would be a
    // validator that says yes to everything, which is the same as none.
    expect(validateToolArgs(spec({ n: { type: "integer" } }), { n: 2.5 })).toContain(
      "arg 'n' must be integer, got a fractional number",
    );
  });

  it("accepts an array, and refuses an object in its place", () => {
    const arrays = spec({ tags: { type: "array" } });
    expect(validateToolArgs(arrays, { tags: ["a", "b"] })).toEqual([]);
    expect(validateToolArgs(arrays, { tags: { a: 1 } })).toContain(
      "arg 'tags' must be array, got object",
    );
  });

  it("accepts a nested object, and refuses an array in its place", () => {
    const nested = spec({ where: { type: "object" } });
    expect(validateToolArgs(nested, { where: { id: 1 } })).toEqual([]);
    // `typeof [] === "object"`, so without this an array satisfied every object
    // property, which is the mirror of the bug above.
    expect(validateToolArgs(nested, { where: [1, 2] })).toContain(
      "arg 'where' must be object, got array",
    );
  });

  it("refuses null where a type was asked for, whatever the type", () => {
    // `typeof null === "object"` is the oldest trap in the language, and it let a
    // null through every object property in the catalogue.
    expect(validateToolArgs(spec({ where: { type: "object" } }), { where: null })).toContain(
      "arg 'where' must be object, got null",
    );
  });

  it("takes a union of types, which is how a server says 'or null'", () => {
    const either = spec({ after: { type: ["string", "null"] } });
    expect(validateToolArgs(either, { after: "2026-01-01" })).toEqual([]);
    expect(validateToolArgs(either, { after: null })).toEqual([]);
    expect(validateToolArgs(either, { after: 7 })).toContain(
      "arg 'after' must be string or null, got number",
    );
  });

  it("does not look inside, and that is the decision, not the omission", () => {
    // The top level is what this validator is for: it turns an obviously wrong
    // call into an input error instead of a policy question. What is inside a
    // nested object is the SERVER's contract to enforce, and a validator that
    // half-walked a schema it does not own would refuse calls the server would
    // have accepted.
    const nested = spec({ where: { type: "object", properties: { id: { type: "number" } } } });
    expect(validateToolArgs(nested, { where: { id: "not a number" } })).toEqual([]);
  });
});
