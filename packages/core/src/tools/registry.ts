/**
 * Tool registry (G1) — the governed agent's action vocabulary.
 *
 * Each tool declares: a JSON-Schema for its args (used both for native
 * function-calling and the constrained-JSON fallback), a `gate` that returns a
 * sandbox verdict (allow | ask | deny) WITHOUT side effects, and an `execute`
 * that performs the action and returns a text observation to feed back to the
 * model. The agent loop owns the policy and only calls `execute` after the gate
 * (and, for `ask`, the human) approves.
 */

import {
  evaluateCommand,
  evaluateFileWrite,
  pathEscapesWorkspace,
  type CommandClass,
  type CommandVerdict,
  type Policy,
} from "../sandbox.js";
import {
  executeCommand,
  executeFileEdit,
  executeFileWrite,
  listDirSafe,
  readFileSafe,
} from "./exec.js";

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments object. */
  parameters: Record<string, unknown>;
  /** Decide allow | ask | deny for these args under the policy. Pure. */
  gate(args: Record<string, unknown>, policy: Policy): CommandVerdict;
  /** Perform the action; returns a text observation for the model. */
  execute(args: Record<string, unknown>, policy: Policy): Promise<string>;
}

const READ_CLASS: CommandClass = { writesFiles: false, network: false, destructive: false, escapesWorkspace: false };

/** Reads are allowed within the workspace; escaping it needs approval. */
function readGate(path: string, policy: Policy): CommandVerdict {
  if (policy.sandbox === "danger-full-access") {
    return { decision: "allow", reason: "full access", class: READ_CLASS };
  }
  const escapes = pathEscapesWorkspace(path, policy.workspaceRoot);
  return escapes
    ? { decision: "ask", reason: "read escapes the workspace", class: { ...READ_CLASS, escapesWorkspace: true } }
    : { decision: "allow", reason: "in-workspace read", class: READ_CLASS };
}

const str = (a: Record<string, unknown>, k: string): string => (typeof a[k] === "string" ? (a[k] as string) : "");

export const TOOLS: ToolSpec[] = [
  {
    name: "run_command",
    description:
      "Run a shell command in the workspace and return its stdout/stderr. Use the command appropriate to the host OS (provided in context).",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["command"],
      properties: { command: { type: "string", description: "The exact shell command to run." } },
    },
    gate: (args, policy) => evaluateCommand(str(args, "command"), policy),
    execute: async (args, policy) => {
      const r = await executeCommand(str(args, "command"), policy);
      const parts = [`exit_code: ${r.code}${r.timedOut ? " (timed out)" : ""}`];
      if (r.stdout.trim()) parts.push(`stdout:\n${r.stdout.trim()}`);
      if (r.stderr.trim()) parts.push(`stderr:\n${r.stderr.trim()}`);
      if (r.truncated) parts.push("[output truncated]");
      return parts.join("\n");
    },
  },
  {
    name: "read_file",
    description: "Read a UTF-8 text file relative to the workspace root.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: { path: { type: "string" } },
    },
    gate: (args, policy) => readGate(str(args, "path"), policy),
    execute: async (args, policy) => {
      const r = readFileSafe(str(args, "path"), policy);
      return r.ok ? `${r.path}:\n${r.content ?? ""}` : `error: ${r.error}`;
    },
  },
  {
    name: "list_dir",
    description: "List the entries of a directory relative to the workspace root.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: { path: { type: "string" } },
    },
    gate: (args, policy) => readGate(str(args, "path"), policy),
    execute: async (args, policy) => {
      const r = listDirSafe(str(args, "path"), policy);
      return r.ok ? `${r.path}:\n${r.content ?? "(empty)"}` : `error: ${r.error}`;
    },
  },
  {
    name: "write_file",
    description: "Create or overwrite a text file (relative to the workspace root) with the given content.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["path", "content"],
      properties: { path: { type: "string" }, content: { type: "string" } },
    },
    gate: (args, policy) => evaluateFileWrite(str(args, "path"), policy),
    execute: async (args, policy) => {
      const r = executeFileWrite(str(args, "path"), str(args, "content"), policy);
      return r.ok ? `wrote ${r.bytes} bytes to ${r.path}` : `error: ${r.error}`;
    },
  },
  {
    name: "edit_file",
    description: "Replace the first occurrence of `find` with `replace` in an existing file.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["path", "find", "replace"],
      properties: { path: { type: "string" }, find: { type: "string" }, replace: { type: "string" } },
    },
    gate: (args, policy) => evaluateFileWrite(str(args, "path"), policy),
    execute: async (args, policy) => {
      const r = executeFileEdit(str(args, "path"), str(args, "find"), str(args, "replace"), policy);
      return r.ok ? `edited ${r.path}` : `error: ${r.error}`;
    },
  },
  {
    name: "finish",
    description: "Call this when the task is complete. Provide a short summary of what was done.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["summary"],
      properties: { summary: { type: "string" } },
    },
    gate: () => ({ decision: "allow", reason: "finish", class: READ_CLASS }),
    execute: async (args) => str(args, "summary"),
  },
];

export const FINISH_TOOL = "finish";

export function toolByName(name: string): ToolSpec | undefined {
  return TOOLS.find((t) => t.name === name);
}
