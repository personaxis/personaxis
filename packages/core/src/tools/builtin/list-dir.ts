/** `list_dir` (J.1): list a directory's entries relative to the workspace root. */
import { defineTool } from "../define.js";

import { readGate } from "../gates.js";

import { missingPathNote, whatIsNearby } from "./nearby.js";

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
  execute: async (args, policy, execution) => {
    const r = await execution.listDir(args.path, policy);
    if (r.ok) return `${r.path}:\n${r.content ?? "(empty)"}`;
    // E31: the runtime used to tell the persona to give up here, and measured
    // against a real model it obeyed: seven of the eight times this branch fired,
    // the task was abandoned. It hands over the neighbouring names instead. See
    // `nearby.ts` for why a better sentence was tried, measured and discarded.
    if (r.error !== "directory not found") return `error: ${r.error}`;
    return missingPathNote(r.path, await whatIsNearby(r.path, policy, execution));
  },
});
