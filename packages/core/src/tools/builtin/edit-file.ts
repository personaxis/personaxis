/** `edit_file` (J.1): replace the first occurrence of `find` with `replace` in a file. */
import { defineTool } from "../define.js";
import { evaluateFileWrite } from "../../sandbox.js";
import { executeFileEdit } from "../exec.js";

export const editFileTool = defineTool({
  name: "edit_file",
  category: "fs",
  isReadOnly: false,
  isConcurrencySafe: false,
  description: "Replace the first occurrence of `find` with `replace` in an existing file.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["path", "find", "replace"],
    properties: { path: { type: "string" }, find: { type: "string" }, replace: { type: "string" } },
  },
  gate: (args, policy) => evaluateFileWrite(args.path, policy),
  execute: async (args, policy) => {
    const r = executeFileEdit(args.path, args.find, args.replace, policy);
    return r.ok ? `edited ${r.path}` : `error: ${r.error}`;
  },
});
