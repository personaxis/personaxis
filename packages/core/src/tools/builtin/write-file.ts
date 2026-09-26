/** `write_file` (J.1): create or overwrite a text file relative to the workspace root. */
import { defineTool } from "../define.js";
import { evaluateFileWrite } from "../../sandbox.js";
import { formatMismatch, pageStartsMidway } from "../file-format.js";
import { syntaxFault } from "../../web/run-page.js";


export const writeFileTool = defineTool({
  name: "write_file",
  category: "fs",
  isReadOnly: false,
  isConcurrencySafe: false,
  description:
    "Create or overwrite a text file (relative to the workspace root) with the given content. " +
    "With append: true, add the content to the end of the file instead, creating it if missing.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["path", "content"],
    properties: { path: { type: "string" }, content: { type: "string" }, append: { type: "boolean" } },
  },
  // Appending writes the same file a replace would, so it goes through the same gate.
  gate: (args, policy) => evaluateFileWrite(args.path, policy),
  execute: async (args, policy, execution) => {
    // E139: a file too long for one reply has to arrive in pieces, and without this the second
    // piece replaced the first. The checks below read the WHOLE file after an append, because
    // the piece alone is not what is on disk.
    const appending = args.append === true;
    const r = appending
      ? await execution.appendFile(args.path, args.content, policy)
      : await execution.writeFile(args.path, args.content, policy);
    if (!r.ok) return `error: ${r.error}`;
    const onDisk = appending ? (r.content ?? args.content) : args.content;
    // E102: the name promised a format the content is not. Said here, beside the result, because
    // this is the line the persona reads and the moment it can still fix it.
    const wrong = formatMismatch(args.path, onDisk);
    // E132: a script that no longer compiles, said in the step that wrote it (see `syntaxFault`).
    const broken = syntaxFault(r.path, onDisk);
    // E139 v2: a page that now begins in its middle, said by the write that did it.
    const midway = pageStartsMidway(r.path, onDisk, !appending);
    const done = appending
      ? `appended ${r.bytes} bytes to ${r.path} (now ${Buffer.byteLength(onDisk)} bytes)`
      : `wrote ${r.bytes} bytes to ${r.path}`;
    return [done, wrong, midway, broken].filter((line): line is string => line !== null).join("\n");
  },
});
