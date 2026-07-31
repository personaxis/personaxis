/**
 * MCP tool adapter (J.1c): turn a tool an external MCP server advertises into a `ToolSpec`,
 * so client-mounted MCP tools enter the SAME registry as the built-ins instead of a parallel
 * path. One uniform catalog is what lets tool-subsetting (J.2) and the interceptor (K.03)
 * treat every tool identically, whatever its origin.
 *
 * The transport is INJECTED (`call`): this adapter is a pure mapping with no opinion on how
 * the server is reached. The stdio/JSON-RPC client that actually connects and lists tools is
 * a separate feature (`personaxis mcp` mounting, still a follow-up); when it lands it supplies
 * `call`, and nothing here changes.
 *
 * Security posture: an MCP tool runs code on an external server, so it is treated as a
 * network action and gated to `ask` by default (the human approves), `allow` only under
 * danger-full-access. It is never allowed silently. Untrusted output it returns is still
 * subject to the ingest injection defense (K.05) upstream.
 */

import type { ToolSpec } from "./registry.js";
import type { CommandClass, CommandVerdict, Policy } from "../sandbox.js";

/** The shape of a tool as an MCP server describes it in `tools/list`. */
export interface McpToolDescriptor {
  name: string;
  description?: string;
  /** JSON Schema for the args (may be nested, unlike the flat built-in schemas). */
  inputSchema?: Record<string, unknown>;
  /** MCP behavior hints, when the server provides them. */
  annotations?: { readOnlyHint?: boolean; idempotentHint?: boolean };
}

/** How the adapter reaches the server. Returns the tool's textual result for the model. */
export type McpCall = (toolName: string, args: Record<string, unknown>) => Promise<string>;

const MCP_CLASS: CommandClass = { writesFiles: false, network: true, destructive: false, escapesWorkspace: false };

/** Adapt one MCP server tool into a `ToolSpec` (category `mcp`, name `server:tool`). */
export function mcpToolToSpec(serverName: string, d: McpToolDescriptor, call: McpCall): ToolSpec {
  const readOnly = d.annotations?.readOnlyHint === true;
  return {
    name: `${serverName}:${d.name}`,
    description: d.description ?? `MCP tool "${d.name}" from server "${serverName}".`,
    category: "mcp",
    // Pass the server's schema through as the single validation source; nested is fine
    // (validateToolArgs checks the top level, which is all the flat built-ins needed too).
    parameters: d.inputSchema ?? { type: "object", properties: {}, additionalProperties: true },
    isReadOnly: readOnly,
    // Concurrency across an external server is unknown; only a read-only + idempotent tool
    // is safe to run in parallel. Everything else serializes.
    isConcurrencySafe: readOnly && d.annotations?.idempotentHint === true,
    gate: (_args: Record<string, unknown>, policy: Policy): CommandVerdict =>
      policy.sandbox === "danger-full-access"
        ? { decision: "allow", reason: "full access", class: MCP_CLASS }
        : { decision: "ask", reason: `external MCP tool (server: ${serverName})`, class: MCP_CLASS },
    // The registry validates args against `parameters` before this runs; here we only relay.
    execute: (args: Record<string, unknown>) => call(d.name, args),
  };
}
