/** `finish` (J.1): the model calls this when the task is complete, with a short summary. */
import { defineTool } from "../define.js";
import { READ_CLASS } from "../gates.js";

export const finishTool = defineTool({
  name: "finish",
  category: "meta",
  isReadOnly: true,
  isConcurrencySafe: true,
  description: "Call this when the task is complete. Provide a short summary of what was done.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["summary"],
    properties: { summary: { type: "string" } },
  },
  gate: () => ({ decision: "allow", reason: "finish", class: READ_CLASS }),
  execute: async (args) => args.summary,
});
