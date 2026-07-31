/**
 * Tool registry (G1), the governed agent's action vocabulary.
 *
 * Each tool declares: a JSON-Schema for its args (used both for native
 * function-calling and the constrained-JSON fallback), a `gate` that returns a
 * sandbox verdict (allow | ask | deny) WITHOUT side effects, and an `execute`
 * that performs the action and returns a text observation to feed back to the
 * model. The agent loop owns the policy and only calls `execute` after the gate
 * (and, for `ask`, the human) approves.
 */

import type { CommandVerdict, Policy } from "../sandbox.js";
import { BUILTIN_TOOLS } from "./builtin/index.js";

/**
 * Namespace a tool belongs to (J.1). Used to subset the catalog per active skill
 * (`fs`+base for a filesystem task, etc.) so the model is not shown every tool at once.
 * Optional on ToolSpec for back-compat: tools authored before J.1 have no category.
 */
export type ToolCategory = "fs" | "shell" | "persona" | "net" | "mcp" | "meta";

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments object, the SINGLE schema source
   * (native function-calling, constrained-JSON fallback, and validateToolArgs
   * all read it; FR.7 decision: no parallel Zod declaration). */
  parameters: Record<string, unknown>;
  /** J.1: which namespace this tool belongs to, for per-skill tool subsetting. */
  category?: ToolCategory;
  /** FR.7: true when the tool cannot change any state, read-only tools may run
   * in PARALLEL; writers run serially (Claude Code's scheduling rule). */
  isReadOnly: boolean;
  /** FR.7: true when concurrent invocations of THIS tool cannot interfere. */
  isConcurrencySafe: boolean;
  /** Decide allow | ask | deny for these args under the policy. Pure. */
  gate(args: Record<string, unknown>, policy: Policy): CommandVerdict;
  /** Perform the action; returns a text observation for the model. */
  execute(args: Record<string, unknown>, policy: Policy): Promise<string>;
}

/**
 * FR.7: validate args against the tool's declared JSON Schema (required keys +
 * primitive types, the registry's schemas are flat by design). Returns the
 * problems found; empty = valid. Runs BEFORE the gate, so a malformed call is
 * an input error, never a policy question.
 */
export function validateToolArgs(spec: ToolSpec, args: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const schema = spec.parameters as {
    required?: string[];
    properties?: Record<string, { type?: string }>;
    additionalProperties?: boolean;
  };
  for (const k of schema.required ?? []) {
    if (!(k in args)) problems.push(`missing required arg '${k}'`);
  }
  for (const [k, v] of Object.entries(args)) {
    const prop = schema.properties?.[k];
    if (!prop) {
      if (schema.additionalProperties === false) problems.push(`unknown arg '${k}'`);
      continue;
    }
    if (prop.type && typeof v !== prop.type) {
      problems.push(`arg '${k}' must be ${prop.type}, got ${typeof v}`);
    }
  }
  return problems;
}

/**
 * The agent's action vocabulary = the union of the built-in tool modules (J.1).
 *
 * The catalog is no longer a hand-written array here: each tool is one file under
 * `builtin/` that declares its schema once via `defineTool` and derives its handler types
 * from it. This file keeps only the CONTRACT (`ToolSpec`) and the runtime validation, so a
 * new capability never means editing a central list.
 */
export const TOOLS: ToolSpec[] = BUILTIN_TOOLS;

export const FINISH_TOOL = "finish";

export function toolByName(name: string): ToolSpec | undefined {
  return TOOLS.find((t) => t.name === name);
}
