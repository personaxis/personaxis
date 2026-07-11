/**
 * FR.4, inbound hooks v2: the shell-out contract.
 *
 * Users extend the engine WITHOUT forking it: a hook is any executable that
 * receives the event payload as JSON on stdin and answers with its exit code, 
 *   exit 0  → ok (stdout MAY carry a JSON decision, e.g. {"decision":"block"})
 *   exit 2  → BLOCK the action (blocking events only)
 *   other   → warning; never blocks
 * (Claude Code's contract; OpenClaw/Hermes use the same folder+manifest idea.)
 *
 * Six initial events. Only PreToolUse and UserPromptSubmit are BLOCKING-capable
 * (awaited, bounded by a timeout that fails OPEN to "continue with warning", 
 * a hook must never hang the pipeline). The rest are fire-and-forget.
 *
 * Config: `.personaxis/hooks.json` beside the persona (project scope), same
 * structural shape as Claude Code's settings hooks block.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type HookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "UserPromptSubmit"
  | "Stop"
  | "SessionStart"
  | "SessionEnd";

export const BLOCKING_EVENTS: readonly HookEvent[] = ["PreToolUse", "UserPromptSubmit"];

export interface HookSpec {
  type: "command";
  command: string;
  /** Per-hook timeout (ms) for blocking events. Default 5000. */
  timeout?: number;
}

export interface HookGroup {
  /** Regex matched against the payload's `matcher_target` (e.g. tool name). */
  matcher?: string;
  hooks: HookSpec[];
}

export interface HooksConfig {
  hooks?: Partial<Record<HookEvent, HookGroup[]>>;
}

export interface HookOutcome {
  command: string;
  /** "ok" | "block" | "warn", block only possible on blocking events. */
  result: "ok" | "block" | "warn";
  exitCode: number | null;
  /** Parsed JSON stdout decision, when the hook emitted one. */
  decision?: Record<string, unknown>;
}

/** Load `.personaxis/hooks.json` for a persona ({} when absent/corrupt). */
export function readHooksConfig(personaPath: string): HooksConfig {
  const p = join(dirname(personaPath), "hooks.json");
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as HooksConfig;
  } catch {
    return {}; // a corrupt hooks file must never break the engine
  }
}

function matching(config: HooksConfig, event: HookEvent, matcherTarget: string): HookSpec[] {
  const groups = config.hooks?.[event] ?? [];
  const out: HookSpec[] = [];
  for (const g of groups) {
    if (g.matcher) {
      try {
        if (!new RegExp(g.matcher).test(matcherTarget)) continue;
      } catch {
        continue; // invalid matcher regex: skip the group, never crash
      }
    }
    out.push(...(g.hooks ?? []));
  }
  return out;
}

function runOne(spec: HookSpec, payload: unknown, awaitResult: boolean): Promise<HookOutcome> {
  return new Promise((resolve) => {
    const child = spawn(spec.command, {
      shell: true,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    const outcome = (result: HookOutcome["result"], exitCode: number | null, stdout = ""): void => {
      let decision: Record<string, unknown> | undefined;
      if (stdout.trim()) {
        try {
          decision = JSON.parse(stdout) as Record<string, unknown>;
        } catch {
          /* non-JSON stdout is fine */
        }
      }
      // A JSON {"decision":"block"} on exit 0 also blocks (blocking events).
      if (awaitResult && decision?.decision === "block" && result === "ok") result = "block";
      resolve({ command: spec.command, result, exitCode, decision });
    };

    if (!awaitResult) {
      // Fire-and-forget: detach outcome from the pipeline entirely.
      child.on("error", () => {});
      try {
        child.stdin.write(JSON.stringify(payload));
        child.stdin.end();
      } catch {
        /* a dead stdin must not throw into the engine */
      }
      resolve({ command: spec.command, result: "ok", exitCode: null });
      return;
    }

    let stdout = "";
    child.stdout.on("data", (c) => (stdout += String(c)));
    const timer = setTimeout(() => {
      child.kill();
      outcome("warn", null, stdout); // timeout fails OPEN: warn, never hang
    }, spec.timeout ?? 5_000);
    child.on("error", () => {
      clearTimeout(timer);
      outcome("warn", null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      outcome(code === 0 ? "ok" : code === 2 ? "block" : "warn", code, stdout);
    });
    try {
      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
    } catch {
      /* the close handler still fires */
    }
  });
}

/**
 * Run every hook configured for `event`. Blocking events await all matched
 * hooks and report `blocked` when ANY says block; fire-and-forget events
 * return immediately (`blocked: false` always).
 */
export async function runHooks(
  event: HookEvent,
  payload: Record<string, unknown>,
  config: HooksConfig,
  matcherTarget = "",
): Promise<{ blocked: boolean; outcomes: HookOutcome[] }> {
  const specs = matching(config, event, matcherTarget);
  if (specs.length === 0) return { blocked: false, outcomes: [] };
  const awaitResult = BLOCKING_EVENTS.includes(event);
  const body = { hook_event: event, ...payload };
  const outcomes = await Promise.all(specs.map((s) => runOne(s, body, awaitResult)));
  return { blocked: awaitResult && outcomes.some((o) => o.result === "block"), outcomes };
}
