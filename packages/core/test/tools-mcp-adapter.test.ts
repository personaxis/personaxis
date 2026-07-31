/**
 * J.1c: an MCP server tool becomes a normal ToolSpec (category "mcp"), gated as an external
 * network action, with the transport injected so the mapping is testable without a server.
 */
import { describe, it, expect, vi } from "vitest";
import { mcpToolToSpec } from "../src/tools/mcp-adapter.js";
import { validateToolArgs } from "../src/tools/registry.js";
import { DEFAULT_POLICY } from "../src/sandbox.js";

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
    expect(await spec.execute({ city: "Lima" }, DEFAULT_POLICY)).toBe("sunny, 22C");
    expect(call).toHaveBeenCalledWith("get_forecast", { city: "Lima" });
  });

  it("defaults conservatively when the server gives no hints: writer, serial", () => {
    const spec = mcpToolToSpec("db", { name: "run_query" }, async () => "");
    expect(spec.isReadOnly).toBe(false);
    expect(spec.isConcurrencySafe).toBe(false);
    expect(spec.name).toBe("db:run_query");
  });
});
