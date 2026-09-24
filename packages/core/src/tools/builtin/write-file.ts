/** `write_file` (J.1): create or overwrite a text file relative to the workspace root. */
import { defineTool } from "../define.js";
import { evaluateFileWrite } from "../../sandbox.js";
import { formatMismatch } from "../file-format.js";
import { syntaxFault } from "../../web/run-page.js";


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
  execute: async (args, policy, execution) => {
    const r = await execution.writeFile(args.path, args.content, policy);
    if (!r.ok) return `error: ${r.error}`;
    // E102: the name promised a format the content is not. Said here, beside the result, because
    // this is the line the persona reads and the moment it can still fix it.
    const wrong = formatMismatch(args.path, args.content);
    // E132: a script that no longer compiles, said in the step that wrote it (see `syntaxFault`).
    const broken = syntaxFault(r.path, args.content);
    return [`wrote ${r.bytes} bytes to ${r.path}`, wrong, broken].filter((line): line is string => line !== null).join("\n");
  },
});
