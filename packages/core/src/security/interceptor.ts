/**
 * Tool-call interceptor (K.03): the single, mandatory path from an approved decision to the
 * operating system. Every tool the agent runs, built-in or MCP, goes through `run`, so there
 * is exactly one place where execution, untrusted-output scanning, post-hooks, and the
 * forensic record happen. A capability cannot quietly acquire a path that skips any of them.
 *
 * The decision (gate + hooks + consent) is made by the caller and passed in; the interceptor
 * enforces what happens AFTER a decision: an approved call is executed and recorded, a blocked
 * call is recorded and never executed. Output is treated as untrusted and scanned before it
 * re-enters the model's context (K.05), because the file or command output the model just read
 * is the primary injection vector, not the model's own arguments.
 */

import { EventBus } from "../events.js";
import { ingestUntrusted } from "./ingest.js";
import { runHooks, type HooksConfig } from "../hooks.js";
import type { ToolSpec } from "../tools/registry.js";
import type { ToolCall } from "../tool-calling.js";
import type { Policy } from "../sandbox.js";
import { ForensicLog, type ForensicRecord } from "./forensic-log.js";

export interface InterceptOutcome {
  output: string;
  ok: boolean;
  outputVerdict: "clean" | "suspicious" | "malicious";
  record: Readonly<ForensicRecord>;
}

export class ToolInterceptor {
  constructor(
    private readonly policy: Policy,
    private readonly forensic: ForensicLog,
    private readonly bus: EventBus = new EventBus(),
    private readonly hooks: HooksConfig | null = null,
  ) {}

  /**
   * Record a call that a decision blocked before it could run (policy deny, a PreToolUse hook
   * veto, a user "no", or invalid args). The record is what proves the block happened.
   */
  recordBlocked(tool: string, decision: "deny" | "ask", reason: string): Readonly<ForensicRecord> {
    return this.forensic.append({ kind: "tool-call", tool, decision, executed: false, reason });
  }

  /**
   * Execute an APPROVED call: run it, scan its untrusted output, fire PostToolUse hooks, and
   * seal a forensic record. Never called for a denied call, so "executed" in the log always
   * means an approved action actually ran.
   */
  async run(tool: ToolSpec, call: ToolCall): Promise<InterceptOutcome> {
    let output: string;
    let ok = true;
    try {
      output = await tool.execute(call.args, this.policy);
    } catch (e) {
      output = `execution error: ${(e as Error).message}`;
      ok = false;
    }
    // A tool that answered with an error/denial string did not do real work.
    if (output.startsWith("error") || output.startsWith("denied")) ok = false;

    // Untrusted output goes through the single ingest door (K.05): scanned, and tagged as data
    // if flagged, before it re-enters the model's context.
    const ingested = ingestUntrusted(output, "tool-output");
    if (ingested.verdict !== "clean") {
      this.bus.emit({ type: "anomaly", kind: `injection:${ingested.verdict}`, detail: "tool output" });
    }
    output = ingested.text;
    this.bus.emit({ type: "tool-result", tool: tool.name, ok, output });

    // PostToolUse hooks are observation only, fire-and-forget, and never block.
    if (this.hooks) {
      void runHooks("PostToolUse", { tool: tool.name, args: call.args, ok }, this.hooks, tool.name);
    }

    const record = this.forensic.append({
      kind: "tool-call",
      tool: tool.name,
      decision: "allow",
      executed: true,
      ok,
      outputVerdict: ingested.verdict,
    });
    return { output, ok, outputVerdict: ingested.verdict, record };
  }
}
