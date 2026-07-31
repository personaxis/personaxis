/** `list_dir` (J.1): list a directory's entries relative to the workspace root. */
import { defineTool } from "../define.js";
import { listDirSafe } from "../exec.js";
import { readGate } from "../gates.js";

export const listDirTool = defineTool({
  name: "list_dir",
  category: "fs",
  isReadOnly: true,
  isConcurrencySafe: true,
  description: "List the entries of a directory relative to the workspace root.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: { path: { type: "string" } },
  },
  gate: (args, policy) => readGate(args.path, policy),
  execute: async (args, policy) => {
    const r = listDirSafe(args.path, policy);
    if (r.ok) return `${r.path}:\n${r.content ?? "(empty)"}`;
    return r.error === "directory not found"
      ? `note: ${r.path} does not exist. Continue with what you have.`
      : `error: ${r.error}`;
  },
});
