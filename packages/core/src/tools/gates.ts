/**
 * Shared gate helpers for the built-in tools (J.1).
 *
 * Extracted from `registry.ts` so the per-tool modules under `builtin/` can import them
 * without importing the registry back (which would make the registry ↔ tool graph cyclic).
 * Gates are pure: they return a verdict, never a side effect.
 */

import { pathEscapesWorkspace, type CommandClass, type CommandVerdict, type Policy } from "../sandbox.js";

/** The class of a pure read: touches nothing, so it can run in parallel. */
export const READ_CLASS: CommandClass = { writesFiles: false, network: false, destructive: false, escapesWorkspace: false };

/** Reads are allowed within the workspace; escaping it needs approval. */
export function readGate(path: string, policy: Policy): CommandVerdict {
  if (policy.sandbox === "danger-full-access") {
    return { decision: "allow", reason: "full access", class: READ_CLASS };
  }
  const escapes = pathEscapesWorkspace(path, policy.workspaceRoot);
  return escapes
    ? { decision: "ask", reason: "read escapes the workspace", class: { ...READ_CLASS, escapesWorkspace: true } }
    : { decision: "allow", reason: "in-workspace read", class: READ_CLASS };
}
