/**
 * Shared REPL types (F3.6 split).
 *
 * This module holds ONLY the cross-module contracts (the session `Ctx`, the
 * command shape, options) and imports nothing from other repl modules, so
 * config/render/daemons/commands/turn/index can all depend on it without a cycle.
 */

import type { ChildProcess } from "node:child_process";
import type {
  LivingLoop,
  Responder,
  PersonaHandle,
  PersonaTheme,
  LoopEvent,
  ToolCall,
  CommandVerdict,
  ApprovalDecision,
  ContextMeter,
  ChatMessage,
} from "@personaxis/core";
import type { LineRole } from "@personaxis/tui/screen";

export interface ReplOptions {
  persona?: string;
}

/** Session context shared by both UIs (Screen + line mode). */
export interface Ctx {
  handle: PersonaHandle;
  loop: LivingLoop;
  responder: Responder;
  theme: PersonaTheme;
  name: string;
  mode: string;
  out: (text: string, role?: LineRole) => void;
  postureIndex: number;
  approve: (call: ToolCall, v: CommandVerdict) => Promise<ApprovalDecision>;
  /** The LLM-facing system prompt = the COMPILED PERSONA.md (slot #1), not the
   * quantitative personaxis.md body. Resources/memory are injected by the agent. */
  personaDoc: string;
  /** Fixed reply color for a sub-persona (ansi256). Undefined => root (default fg). */
  replyColor?: number;
  /** Persistent conversation (no system message) for chat continuity. */
  conversation: ChatMessage[];
  /** Id of the on-disk session backing this conversation. */
  sessionId: string;
  /** Whether the session file (header) has been written yet (lazy on first turn). */
  sessionStarted: boolean;
  /** Whether the session has been auto-named yet. */
  sessionNamed: boolean;
  /** Session-level context-window meter (persists across turns). */
  meter: ContextMeter;
  /** Update the spinner phase label (Screen mode only). */
  phase?: (label: string) => void;
  /** A one-shot environment note (e.g. "sandbox posture changed") to prepend to the NEXT
   * agent turn so the model re-evaluates a request it may have declined under the old posture. */
  pendingEnvNote?: string;
  /** Long-running daemons (serve/watch) launched from `/` in the background, so they can be stopped. */
  bg?: Record<string, ChildProcess>;
  // ── FASE 7 P2: the app breathes the math (screen mode only) ────────────────
  /** Feed the loop's per-tick DriftReport to the live gauge + drift view. */
  onDrift?: (report: unknown) => void;
  /** Stage the band-crossing moment in the live region. */
  onMoment?: (crossings: Array<{ field: string; fromBand: string; toBand: string; prose: string | null }>) => void;
  /** Switch the app to the full-height drift view (Esc returns to chat). */
  openDriftView?: () => void;
  /** Hand the raw TTY to a full-screen flow (proof scenes, the Genesis wizard). */
  suspend?: (fn: () => Promise<void>) => Promise<void>;
}

export interface CommandDef {
  name: string;
  desc: string;
  run(arg: string, ctx: Ctx): Promise<boolean | void> | boolean | void;
}

/** Re-export for modules that only need the display-line role. */
export type { LineRole, LoopEvent };
