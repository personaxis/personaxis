/** `write_file` (J.1): create or overwrite a text file relative to the workspace root. */
import { defineTool } from "../define.js";
import { evaluateFileWrite } from "../../sandbox.js";
import { executeFileWrite } from "../exec.js";

export const writeFileTool = defineTool({
  name: "write_file",
  category: "fs",
  isReadOnly: false,
  isConcurrencySafe: false,
  description: "Create or overwrite a text file (relative to the workspace root) with the given content.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["path", "content"],
    properties: { path: { type: "string" }, content: { type: "string" } },
  },
  gate: (args, policy) => evaluateFileWrite(args.path, policy),
  execute: async (args, policy) => {
    const r = executeFileWrite(args.path, args.content, policy);
    return r.ok ? `wrote ${r.bytes} bytes to ${r.path}` : `error: ${r.error}`;
  },
});
