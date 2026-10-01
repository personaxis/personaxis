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
import type { ExecutionPort } from "../ports/execution.js";
import { BUILTIN_TOOLS } from "./builtin/index.js";
import type { ActionClass } from "../enforcement/action-classes.js";

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
  /**
   * K6: the action classes this tool can produce, when it says so.
   *
   * Optional here and REQUIRED of a contribution, and the asymmetry is the point. The
   * built-ins are in the inference table by name and have been since it was written; a
   * plugin is not and never will be. Measured: `github:create_issue` infers to an empty
   * list, so a tool that writes to a remote service is weighed as nothing on the axis
   * that exists to weigh it.
   *
   * A declaration widens and never shrinks. It is unioned with whatever the runtime can
   * infer, because a capability that could shrink its own classification would be
   * marking its own homework, and this is the one place where the subject of the
   * measurement supplies the input.
   */
  envelope?: readonly ActionClass[];
  /** Decide allow | ask | deny for these args under the policy. Pure. */
  gate(args: Record<string, unknown>, policy: Policy): CommandVerdict;
  /** Perform the action; returns a text observation for the model. */
  /**
   * F2: `execution` is WHERE the action happens, injected rather than assumed. A tool that
   * reached for `spawn` itself would run on whatever machine hosts the process, which for a
   * hosted job is the wrong one and fails silently by working.
   */
  execute(args: Record<string, unknown>, policy: Policy, execution: ExecutionPort): Promise<string>;
  /**
   * E160: the part of this tool's output that came from outside, for an injection classifier to read. Absent, the
   * whole output is. A tool that wraps outside text in words of the engine's own says which part is which, because the
   * engine's words, read alone, can look like the attack they warn about.
   */
  outside?(output: string): string;
}

/**
 * The type of a value the way JSON Schema names types, which is not the way
 * `typeof` names them.
 *
 * Three of the differences are the whole reason this function exists, and each one
 * was a live fault: `typeof []` is `"object"`, so an array satisfied every object
 * property AND failed every array one; `typeof null` is `"object"`, so a null
 * passed as any object; and `integer` is a JSON Schema type with no JavaScript
 * counterpart at all, so an integer property refused every integer.
 */
function jsonTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** Does a value satisfy one declared JSON Schema type? */
function isOfJsonType(value: unknown, type: string): boolean {
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  return jsonTypeOf(value) === type;
}

/**
 * FR.7: validate args against the tool's declared JSON Schema. Returns the
 * problems found; empty = valid. Runs BEFORE the gate, so a malformed call is
 * an input error, never a policy question.
 *
 * ## The built-ins are flat; what arrives here is not
 *
 * FR.7 keeps the BUILT-IN schemas flat and that decision stands: it is what lets
 * `defineTool` project one schema onto both the model's view and the handler's
 * argument type. But this function does not only see built-ins. `mcpToolToSpec`
 * passes a third party's schema straight through, by design, and an MCP server
 * writes whatever JSON Schema it likes: `integer`, `array`, a nested object, a
 * union of two types. Measured on 2026-09-06 against the checks this had:
 * **every `integer` and every `array` property refused every valid call**, and
 * because validation runs before the gate, those calls never reached a policy
 * question. They were reported to the model as malformed arguments, which is a
 * sentence that sends it off to fix an argument that was already right.
 *
 * ## Top level only, and that is a decision
 *
 * What is inside a nested object is the SERVER's contract, and half-walking a
 * schema we do not own would refuse calls the server would have accepted. This
 * exists to turn an obviously wrong call into an input error, not to be a JSON
 * Schema implementation.
 */
export function validateToolArgs(spec: ToolSpec, args: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const schema = spec.parameters as {
    required?: string[];
    properties?: Record<string, { type?: string | string[] }>;
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
    if (!prop.type) continue;

    // A list of types is legal JSON Schema and servers use it, most often to say
    // "a string or null". Satisfying any one of them is satisfying the property.
    const declared = Array.isArray(prop.type) ? prop.type : [prop.type];
    if (declared.length === 0 || declared.some((type) => isOfJsonType(v, type))) continue;

    // Named as JSON names it, so the model reads "got array" instead of the
    // "got object" that sent it looking for a fault in the wrong argument.
    const wanted = declared.join(" or ");
    const got =
      declared.includes("integer") && typeof v === "number" ? "a fractional number" : jsonTypeOf(v);
    problems.push(`arg '${k}' must be ${wanted}, got ${got}`);
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
