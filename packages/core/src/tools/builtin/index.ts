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
import { findInFilesTool } from "./find-in-files.js";
import { writeFileTool } from "./write-file.js";
import { editFileTool } from "./edit-file.js";
import { checkPageTool } from "./check-page.js";
import { finishTool } from "./finish.js";

export const BUILTIN_TOOLS: ToolSpec[] = [
  runCommandTool,
  readFileTool,
  listDirTool,
  // C5: after the two reads it sits between, because the order here is the order
  // the model is shown and a catalogue that reshuffles moves the prompt prefix.
  findInFilesTool,
  writeFileTool,
  editFileTool,
  // E98, 2026-09-15: it was imported here and left out of this list, so `E71` gave every persona a way to run
  // the page it wrote and no persona was ever offered it. Measured: not one call to it in anything the autonomy
  // bench has saved, and the service step written to use it said it would verify "without relying on unavailable
  // tools". After the two writes, because that is when a page exists to run.
  checkPageTool,
  finishTool,
];
