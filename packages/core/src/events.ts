/**
 * Submit/event bus — engine ⟂ UI separation (the Codex pattern).
 *
 * The engine never prints. It emits typed events; consumers (REPL, TUI, MCP,
 * HTTP) render them. This keeps one core reusable across every entry point.
 */

import type { MutationResult } from "./state-engine.js";
import type { AppraisalSignal } from "./appraisal.js";
import type { Verdict } from "./governance.js";
import type { MemoryEntry } from "./memory.js";

export type LoopEvent =
  | { type: "observe"; observation: string; source: string }
  | { type: "appraise"; signal: AppraisalSignal }
  | { type: "govern"; verdicts: Verdict[] }
  | { type: "mutate"; result: MutationResult }
  | { type: "memory"; entry: MemoryEntry }
  | { type: "anomaly"; kind: string; detail: string }
  | { type: "recompile"; reason: string }
  | { type: "abstain"; reason: string }
  | { type: "error"; message: string }
  | { type: "tick-complete"; mutationsApplied: number; memoriesWritten: number };

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
