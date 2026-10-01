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
import { fromOutside, type Tainted } from "./taint.js";
import { CredentialBroker } from "./broker.js";

/**
 * Fills every reference in a call's arguments, on a copy.
 *
 * On a copy because the original arguments are what the gate froze and what the record
 * holds: rewriting them in place would make the record say the call carried a
 * credential, which is both untrue and the exact thing this is for.
 *
 * Only string values are walked. A credential arriving as a number or a boolean is not
 * a case that exists, and pretending to handle it would be code nobody can test.
 */
function fillArgs(
  broker: CredentialBroker,
  args: Record<string, unknown>,
): { args: Record<string, unknown>; missing: string[] } {
  const filled: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== "string") {
      filled[key] = value;
      continue;
    }
    const result = broker.fill(value);
    filled[key] = result.text;
    missing.push(...result.missing);
  }
  return { args: filled, missing: [...new Set(missing)] };
}
import { runHooks, type HooksConfig } from "../hooks.js";
import type { ToolSpec } from "../tools/registry.js";
import type { ToolCall } from "../tool-calling.js";
import type { Policy } from "../sandbox.js";
import { localExecution, type ExecutionPort } from "../ports/execution.js";
import { ForensicLog, type ForensicRecord } from "./forensic-log.js";

export interface InterceptOutcome {
  /**
   * What the tool returned, marked as having come from outside (E13).
   *
   * Tainted rather than a plain string, and that IS the defence. It used to be a
   * string beside an `outputVerdict`, with the loop writing
   * `contextTaint = maxTaint(contextTaint, r.outputVerdict)` next to it: correct, and
   * correct in the way that lasts until somebody adds a second place that runs a tool
   * and copies the four lines that matter and not the fifth. Nothing fails then. The
   * taint simply stops accumulating, the consent matrix stops tightening, and a
   * destructive call during a malicious-tainted turn is allowed by a check that ran
   * and had nothing to check.
   *
   * `accept` is the only way to read it, and it returns the combined taint in the same
   * object, so forgetting is a type error rather than an oversight.
   */
  output: Tainted<string>;
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
    /**
     * F2: WHERE an allowed action happens. Defaults to this machine, which is what every
     * existing caller means; a hosted job passes the sandbox's port instead and nothing
     * else about this class changes. The default lives here, in ONE place, rather than in
     * each tool: a per-tool fallback is how one tool ends up running locally during a
     * hosted job, and it would work perfectly, on the wrong machine.
     */
    private readonly execution: ExecutionPort = localExecution(),
    /**
     * E14: holds the credentials the agent may USE and may never see.
     *
     * Optional, and absent is the ordinary case: a persona with no credentials
     * configured has nothing to exchange. When present, references in the arguments
     * become values one line before execution and every value is scrubbed out of the
     * result, so nothing downstream, including the record, ever holds one.
     */
    private readonly broker?: CredentialBroker,
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
  /**
   * E154: whether a file is already there, asked of the same execution port the tools write through, so the answer
   * is about the machine the work happens on and not about this one.
   */
  async exists(path: string): Promise<boolean> {
    try {
      return (await this.execution.readFile(path, this.policy)).ok;
    } catch {
      return false;
    }
  }

  async run(tool: ToolSpec, call: ToolCall): Promise<InterceptOutcome> {
    let output: string;
    let ok = true;
    // E14: references become values HERE, one line before the bytes leave, and never
    // sooner. Anything that substituted earlier would have produced a string holding a
    // credential, and that string gets logged by somebody eventually.
    //
    // The arguments the gate judged and the record kept are the ones with the
    // reference still in them, which is the property that makes this safe to audit: a
    // record entry can be read by anyone without leaking anything.
    const filled = this.broker ? fillArgs(this.broker, call.args) : { args: call.args, missing: [] };
    if (filled.missing.length > 0) {
      // Named and refused rather than sent. Leaving the literal `{{secret:x}}` in place
      // sends a request some servers log verbatim, and substituting an empty string
      // sends one that reads as an authentication bug for as long as it takes somebody
      // to find this line.
      const record = this.forensic.append({
        kind: "tool-call",
        tool: tool.name,
        decision: "deny",
        executed: false,
        reason: `no credential for ${filled.missing.join(", ")}`,
      });
      return {
        output: fromOutside(
          `error: this machine holds no credential named ${filled.missing.join(", ")}`,
          "clean",
          `tool:${tool.name}`,
        ),
        ok: false,
        outputVerdict: "clean",
        record,
      };
    }
    try {
      output = await tool.execute(filled.args, this.policy, this.execution);
      // And back through the broker on the way out. Skipping this undoes the rest: an
      // agent that can send a header can send something that echoes it back, and the
      // secret arrives in output it was never meant to hold.
      if (this.broker) output = this.broker.scrub(output);
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
    return {
      // Marked at the boundary, and the boundary is here: this is the moment somebody
      // else's text enters this process. Everything downstream inherits the obligation
      // from the type rather than from a convention.
      output: fromOutside(output, ingested.verdict, `tool:${tool.name}`),
      ok,
      outputVerdict: ingested.verdict,
      record,
    };
  }
}
