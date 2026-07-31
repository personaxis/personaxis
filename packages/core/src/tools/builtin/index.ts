/**
 * The built-in tool catalog (J.1) = the UNION of the per-tool modules, not a central array.
 *
 * Adding a capability is one new file plus one line here; there is no hand-maintained schema
 * to keep in sync, because each module declares its schema once via `defineTool` and derives
 * its handler types from it. Order is preserved from the original registry.
 */
import type { ToolSpec } from "../registry.js";
import { runCommandTool } from "./run-command.js";
import { readFileTool } from "./read-file.js";
import { listDirTool } from "./list-dir.js";
import { writeFileTool } from "./write-file.js";
import { editFileTool } from "./edit-file.js";
import { finishTool } from "./finish.js";

export const BUILTIN_TOOLS: ToolSpec[] = [
  runCommandTool,
  readFileTool,
  listDirTool,
  writeFileTool,
  editFileTool,
  finishTool,
];
