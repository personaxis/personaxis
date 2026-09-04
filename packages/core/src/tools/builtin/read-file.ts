/** `read_file` (J.1): read a UTF-8 text file relative to the workspace root. */
import { defineTool } from "../define.js";

import { readGate } from "../gates.js";

import { missingPathNote, whatIsNearby } from "./nearby.js";

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
  execute: async (args, policy, execution) => {
    const r = await execution.readFile(args.path, policy);
    if (r.ok) return `${r.path}:\n${r.content ?? ""}`;
    // V3.1: a missing file is an ANSWER, not a failure. Marking it "error:" zeroed step
    // progress and tripped the no_progress / execution_error stop conditions, so an
    // optional read could abort a whole run without a reply.
    // E31: the runtime used to tell the persona to give up here, and measured
    // against a real model it obeyed: seven of the eight times this branch fired,
    // the task was abandoned. It hands over the neighbouring names instead. See
    // `nearby.ts` for why a better sentence was tried, measured and discarded.
    if (r.error !== "file not found") return `error: ${r.error}`;
    return missingPathNote(r.path, await whatIsNearby(r.path, policy, execution));
  },
});
