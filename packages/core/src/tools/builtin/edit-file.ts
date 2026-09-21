/** `edit_file` (J.1): replace the first occurrence of `find` with `replace` in a file. */
import { defineTool } from "../define.js";
import { evaluateFileWrite } from "../../sandbox.js";
import { executeFileEdit } from "../exec.js";
import { openSync, readSync, closeSync } from "node:fs";

import { formatMismatch } from "../file-format.js";


/**
 * The first bytes of a file, as text, or an empty string when it cannot be read.
 *
 * Only the head: every signature this checks is four bytes or fewer, and reading a whole file after every
 * edit to look at four of them would be a cost paid on every call for one rare case.
 */
function headOf(path: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(8);
    const read = readSync(fd, buffer, 0, 8, 0);
    return buffer.subarray(0, read).toString("latin1");
  } catch {
    // The edit reported success, so this is something else: a race, a permission. Not worth a warning.
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

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
    if (!r.ok) return `error: ${r.error}`;
    // E102, same as `write_file`: an edit can leave a file whose name promises a format its content is
    // not, and it is judged on what the file NOW holds rather than on the piece that was pasted.
    //
    // Read from disk and not from `r.content`, which is the DIFF this tool reports. Judging the patch
    // made an untouched PDF warn, which is the worst thing a warning can do: teach people to skip it.
    const wrong = formatMismatch(r.path, headOf(r.path));
    const said = `edited ${r.path}\n${r.content ?? ""}`.trimEnd();
    return wrong === null ? said : `${said}\n${wrong}`;
  },
});
