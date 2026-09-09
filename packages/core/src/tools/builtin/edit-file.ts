/** `edit_file` (J.1): replace the first occurrence of `find` with `replace` in a file. */
import { defineTool } from "../define.js";
import { evaluateFileWrite } from "../../sandbox.js";
import { executeFileEdit } from "../exec.js";

export const editFileTool = defineTool({
  name: "edit_file",
  category: "fs",
  isReadOnly: false,
  isConcurrencySafe: false,
  description:
    "Replace `find` with `replace` in an existing file. The find text must appear exactly " +
    "once: include enough surrounding lines to name one place, or this refuses rather than " +
    "guessing which one you meant. Returns the change it made.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["path", "find", "replace"],
    properties: { path: { type: "string" }, find: { type: "string" }, replace: { type: "string" } },
  },
  gate: (args, policy) => evaluateFileWrite(args.path, policy),
  execute: async (args, policy) => {
    const r = executeFileEdit(args.path, args.find, args.replace, policy);
    // What changed, not just that something did. An edit that reported only its path
    // could not be told apart from one that landed somewhere else that happened to
    // match, which is the failure the ambiguity check upstream now refuses outright.
    return r.ok ? `edited ${r.path}\n${r.content ?? ""}`.trimEnd() : `error: ${r.error}`;
  },
});
