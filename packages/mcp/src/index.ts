#!/usr/bin/env node
/**
 * @personaxis/mcp — expose a living, governed persona as MCP tools.
 *
 * Any MCP host (Claude Code, Codex, Cursor, …) can `personaxis-mcp` and call:
 *   - persona_compiled       read the identity document (system-prompt slot #1)
 *   - persona_state          read current envelope values + recent mutations
 *   - persona_envelopes      list mutable fields + their [min,max] ranges
 *   - adjust_persona_state   apply a clamped, audited mutation (spec runtime tool)
 *   - persona_observe        run one governed Living-Loop cycle on an observation
 *   - persona_audit          mutation log + memory-chain integrity
 *
 * The big host brings the powerful model; personaxis brings the *living identity*.
 * Every mutation is clamped + audited; nothing bypasses the governance gate.
 *
 * Tool descriptions are intentionally rich — research shows description quality is
 * the main driver of correct tool/argument selection by host models.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { ProvenanceSource } from "@personaxis/core";
import * as svc from "./service.js";

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}
function fail(err: unknown) {
  return {
    content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
    isError: true,
  };
}

const personaArg = {
  persona: z
    .string()
    .describe("Path to the persona's personaxis.md (or compiled PERSONA.md). Its state.json is read/written alongside it."),
};

export function buildServer(): McpServer {
  const server = new McpServer({ name: "personaxis", version: "0.7.0" });

  server.tool(
    "persona_compiled",
    "Return the persona's compiled identity document (the qualitative PERSONA.md body). Load this as system-prompt slot #1 to give your session this persona's identity.",
    personaArg,
    async ({ persona }) => {
      try {
        return ok({ compiled: svc.compiledDocument(persona) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "persona_state",
    "Return the persona's current runtime state: live envelope values (traits/affect/mood), mutation count, and the 5 most recent audited mutations.",
    personaArg,
    async ({ persona }) => {
      try {
        return ok(svc.stateSummary(persona));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "persona_envelopes",
    "List the persona's mutable fields with their declared [min,max] envelopes, plus virtues under hard enforcement (which are never mutable at runtime).",
    personaArg,
    async ({ persona }) => {
      try {
        return ok(svc.envelopes(persona));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "adjust_persona_state",
    "Apply a single runtime mutation to an envelope field by a signed delta. The delta is CLAMPED to the field's declared envelope and APPENDED to an immutable mutation_log. Returns the from/to values and whether it was clamped. This is the spec's adjust_persona_state(field, delta, reason) tool.",
    {
      ...personaArg,
      field: z.string().describe("Dot-notation field, e.g. 'mood.tone', 'affect.valence', 'traits.openness'."),
      delta: z.number().describe("Signed delta to apply; clamped to the envelope."),
      reason: z.string().describe("Short rationale, recorded in the audit log."),
    },
    async ({ persona, field, delta, reason }) => {
      try {
        return ok(svc.adjustState(persona, field, delta, reason));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "persona_observe",
    "Run ONE governed Living-Loop cycle (observe -> appraise -> evolve -> memory) on an observation. Mutations are clamped + governed (locked personas won't self-evolve); a lineage-tagged memory is written. Returns the per-step events and a report.",
    {
      ...personaArg,
      observation: z.string().describe("What happened / what the user said."),
      source: z
        .enum(["user", "tool", "internal", "synthesis"])
        .default("user")
        .describe("Provenance of the observation (drives trust + sensitive-action gates)."),
    },
    async ({ persona, observation, source }) => {
      try {
        return ok(await svc.observe(persona, observation, source as ProvenanceSource));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "persona_audit",
    "Return the recent mutation log plus episodic-memory chain integrity (tamper/poisoning detection). Use this to verify the persona's evolution has not been corrupted.",
    personaArg,
    async ({ persona }) => {
      try {
        return ok(svc.audit(persona));
      } catch (e) {
        return fail(e);
      }
    },
  );

  return server;
}

async function main(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Run only when invoked directly (bin). Importers (tests) use buildServer().
const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entry) {
  main().catch((err) => {
    console.error("personaxis-mcp fatal:", err);
    process.exit(1);
  });
}
