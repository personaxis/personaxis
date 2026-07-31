/** `run_command` (J.1): run a shell command in the workspace, return stdout/stderr. */
import { defineTool } from "../define.js";
import { evaluateCommand } from "../../sandbox.js";
import { executeCommand } from "../exec.js";

export const runCommandTool = defineTool({
  name: "run_command",
  category: "shell",
  isReadOnly: false,
  isConcurrencySafe: false,
  description:
    "Run a shell command in the workspace and return its stdout/stderr. Use the command appropriate to the host OS (provided in context).",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["command"],
    properties: { command: { type: "string", description: "The exact shell command to run." } },
  },
  gate: (args, policy) => evaluateCommand(args.command, policy),
  execute: async (args, policy) => {
    const r = await executeCommand(args.command, policy);
    const parts = [`exit_code: ${r.code}${r.timedOut ? " (timed out)" : ""}`];
    if (r.stdout.trim()) parts.push(`stdout:\n${r.stdout.trim()}`);
    if (r.stderr.trim()) parts.push(`stderr:\n${r.stderr.trim()}`);
    if (r.truncated) parts.push("[output truncated]");
    return parts.join("\n");
  },
});
