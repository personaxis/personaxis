/** `read_file` (J.1): read a UTF-8 text file relative to the workspace root. */
import { defineTool } from "../define.js";
import { readFileSafe } from "../exec.js";
import { readGate } from "../gates.js";

export const readFileTool = defineTool({
  name: "read_file",
  category: "fs",
  isReadOnly: true,
  isConcurrencySafe: true,
  description: "Read a UTF-8 text file relative to the workspace root.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: { path: { type: "string" } },
  },
  gate: (args, policy) => readGate(args.path, policy),
  execute: async (args, policy) => {
    const r = readFileSafe(args.path, policy);
    if (r.ok) return `${r.path}:\n${r.content ?? ""}`;
    // V3.1: a missing file is an ANSWER, not a failure. Marking it "error:" zeroed step
    // progress and tripped the no_progress / execution_error stop conditions, so an
    // optional read could abort a whole run without a reply.
    return r.error === "file not found"
      ? `note: ${r.path} does not exist. Continue with what you have.`
      : `error: ${r.error}`;
  },
});
