/**
 * Submit/event bus, engine ⟂ UI separation (the Codex pattern).
 *
 * The engine never prints. It emits typed events; consumers (REPL, TUI, MCP,
 * HTTP) render them. This keeps one core reusable across every entry point.
 */

import type { MutationResult } from "./state-engine.js";
import type { AppraisalSignal } from "./appraisal.js";
import type { Verdict } from "./governance.js";
import type { MemoryEntry } from "./memory.js";
import type { DriftReport } from "./math/drift.js";

export type LoopEvent =
  | { type: "observe"; observation: string; source: string }
  | { type: "appraise"; signal: AppraisalSignal }
  | { type: "govern"; verdicts: Verdict[] }
  | { type: "mutate"; result: MutationResult }
  | { type: "memory"; entry: MemoryEntry }
  | { type: "memory-kind"; kind: "procedural" | "autobiographical" | "user_preferences" | "evaluations"; detail: string }
  // Memory consumed to answer this turn (resumeContext injected it). One per kind, with a count.
  | { type: "memory-recall"; kind: "episodic" | "semantic" | "procedural" | "autobiographical" | "user_preferences"; count: number; detail?: string }
  // A single quality/utility score written this turn (target + dimension + score), so the UI can
  // show WHAT was evaluated, not just "+N eval(s)".
  | { type: "evaluation"; target: string; dimension: string; score: number; rationale: string }
  | { type: "self-edit"; op: "queued" | "applied" | "rejected"; targetPath: string; id?: string; reason?: string }
  | { type: "anomaly"; kind: string; detail: string }
  // Drift metric after this tick's mutations (F6.2, MATH_CORE.md Def. 5): global D,
  // the coordinates that crossed a band, and the layers over their declared threshold.
  // FASE 7 P2 (gap G5): the event carries the FULL report the loop already computed,
  // so no surface (REPL, dash, MCP, serve) has to re-read state from disk to paint.
  | { type: "drift"; global: number; crossings: string[]; layersExceeded: string[]; report: DriftReport }
  // FASE 7 P2: structured crossing details alongside the human-readable reason, so
  // the UI can stage the band-crossing moment without parsing strings. `prose` is
  // the expression line the NEW band injects into the compiled document.
  | {
      type: "recompile";
      reason: string;
      crossings?: Array<{ field: string; fromBand: string; toBand: string; prose: string | null }>;
    }
  | { type: "abstain"; reason: string }
  | { type: "error"; message: string }
  | { type: "tick-complete"; mutationsApplied: number; memoriesWritten: number }
  // Agent loop (G1), governed task execution.
  | { type: "agent-step"; step: number }
  | { type: "agent-think"; text: string }
  | { type: "tool-propose"; tool: string; args: Record<string, unknown> }
  | { type: "tool-verdict"; tool: string; decision: "allow" | "ask" | "deny"; reason: string }
  | { type: "tool-result"; tool: string; ok: boolean; output: string }
  | { type: "agent-finish"; summary: string; steps: number }
  | { type: "agent-error"; message: string }
  // Agent budget + stop conditions (v0.9)
  | { type: "agent-budget"; step: number; tokens: number; costUsd: number; wallSeconds: number }
  | { type: "agent-stop-condition"; reason: string; step: number }
  // Objective verification (v0.9)
  | { type: "verify-start"; gates: number }
  | { type: "verify-result"; verifier: string; pass: boolean; reason: string }
  | { type: "verify-complete"; passed: boolean; passes: number; quorum: number }
  // Trace export (v0.9, P3)
  | { type: "trace-exported"; format: string; path: string; spanCount: number }
  // Context-window manager
  | { type: "context-meter"; used: number; limit: number; pct: number }
  | { type: "context-compacted"; removed: number; usedAfter: number };

export type LoopListener = (e: LoopEvent) => void;

export class EventBus {
  private listeners: LoopListener[] = [];

  on(listener: LoopListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  emit(e: LoopEvent): void {
    for (const l of this.listeners) l(e);
  }
}
