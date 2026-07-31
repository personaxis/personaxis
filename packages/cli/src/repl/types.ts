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
  /** `--continue`: resume the most recent saved conversation for this persona. */
  continueLast?: boolean;
  /** `--resume [id]`: resume this session id/name; "" lists sessions and starts fresh. */
  resume?: string;
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
  /**
   * Ask the user for a line of text, from inside a view.
   *
   * Needed so a capability that takes an ARGUMENT can live where it was absorbed
   * rather than surviving as a hidden command: setting a goal, choosing how many
   * loop ticks to run. Without it, "absorbed" would have meant "still typed as
   * `/goal <text>`", which is the noise this consolidation exists to remove.
   * Undefined without a TTY, where the external subcommand is the way in.
   */
  ask?: (prompt: string) => Promise<string>;
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
  /** Whether closeSession already ran for this ctx (distill/consolidate/prune once). */
  sessionClosed?: boolean;
  /** Session-level context-window meter (persists across turns). */
  meter: ContextMeter;
  /**
   * What this instance is doing right now (V9/G.2), so the fleet/Command Center shows real
   * activity instead of a permanent "idle". A mutable holder because the heartbeat and the turn
   * dispatcher both read/write it; `noteActivity` updates it and re-announces immediately.
   */
  presence: { activity: string };
  /** Cumulative token/cost accounting for this session (F3.D16: /cost, /usage).
   *  byModel (V5.P1.2): per-model breakdown for the Settings > Usage tab. */
  usage: {
    turns: number;
    tokens: number;
    costUsd: number;
    steps: number;
    byModel?: Record<string, { turns: number; tokens: number; costUsd: number }>;
  };
  /** Update the spinner phase label (Screen mode only). */
  phase?: (label: string) => void;
  /** A one-shot environment note (e.g. "sandbox posture changed") to prepend to the NEXT
   * agent turn so the model re-evaluates a request it may have declined under the old posture. */
  pendingEnvNote?: string;
  /** Long-running daemons (serve/watch) launched from `/` in the background, so they can be stopped. */
  bg?: Record<string, ChildProcess>;
  /**
   * What each background daemon actually IS, beyond a live process handle.
   *
   * The handle alone answers "is something running"; a reader needs to know which port it
   * answers on, whether it demands a token, since when, and what the thing is FOR. Kept
   * beside `bg` rather than inside it because `bg` holds Node's ChildProcess, which we do
   * not own and must not decorate.
   */
  daemonInfo?: Record<string, DaemonInfo>;
  // ── FASE 7 P2: the app breathes the math (screen mode only) ────────────────
  /** Feed the loop's per-tick DriftReport to the live gauge + drift view. */
  onDrift?: (report: unknown) => void;
  /** Stage the band-crossing moment in the live region. */
  onMoment?: (crossings: Array<{ field: string; fromBand: string; toBand: string; prose: string | null }>) => void;
  /** Switch the app to the full-height drift view (Esc returns to chat). */
  openDriftView?: () => void;
  /** V5.P1.1: open any registered full-height view by name (settings, resume, ...). */
  openView?: (name: string, params?: Record<string, unknown>) => void;
  /** Hand the raw TTY to a full-screen flow (proof scenes, the Genesis wizard). */
  suspend?: (fn: () => Promise<void>) => Promise<void>;
  /** V7.A6: wipe screen + transcript buffer, for switching to another conversation. */
  clearScreen?: () => void;
}

/** A running background daemon, described well enough to be understood at a glance. */
export interface DaemonInfo {
  /** One sentence on what this daemon is for, in plain language. */
  purpose: string;
  /** TCP port, when it serves one. */
  port?: number;
  /** Whether requests must carry a bearer token. */
  tokenRequired?: boolean;
  /** Address it binds to; local-only unless deliberately changed. */
  host?: string;
  /** Epoch ms it started, so uptime is derivable rather than stored stale. */
  startedAt: number;
}

export interface CommandDef {
  name: string;
  desc: string;
  run(arg: string, ctx: Ctx): Promise<boolean | void> | boolean | void;
  /**
   * EXTERNAL PARITY: how a coding agent reaches this capability without the TUI.
   *
   * Agents cannot drive menus, so every capability must either have a non-interactive
   * subcommand or be honestly declared as belonging to a live session. Declaring it per
   * command (rather than keeping a separate list) is what makes the parity test able to
   * fail on a NEW command: an unset field is an unanswered question, not a silent pass.
   *
   *   string          the `personaxis <...>` subcommand that does the same job
   *   "session-only"  meaningless outside a running conversation (its own scrollback,
   *                   context window, child processes or posture), with `why` explaining it
   */
  external: string | "session-only";
  /** Required when `external` is "session-only": why there is nothing to expose. */
  why?: string;
}

/** Re-export for modules that only need the display-line role. */
export type { LineRole, LoopEvent };
