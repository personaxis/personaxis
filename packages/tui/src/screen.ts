/**
 * Shared REPL surface TYPES.
 *
 * The pre-Ink `Screen` line-editor class lived here until V2-F2; it is gone (the
 * REPL renders through `InkScreen`, and its cursor-following menu logic now lives
 * as the shared, tested `windowFor` in `viewport.ts`). What remains is the small
 * set of interface types `InkScreen` and its hosts share: `ReplHooks`, `SlashItem`,
 * and `LineRole`. No runtime code, types only, so importing them is free.
 */

export type LineRole = "user" | "persona" | "activity" | "system" | "divider";

export interface SlashItem {
  name: string;
  desc: string;
}

export interface ReplHooks {
  /** The prompt prefix, e.g. "❯ ". */
  prompt(): string;
  /** A status line shown BELOW the input (tokens · time · mode). */
  status(): string;
  commands: SlashItem[];
  onSubmit(line: string): Promise<void> | void;
  onCycleMode?(): void;
  onExit?(): void;
  /** V2-F2, Ctrl+K opens the Command Center (the command-palette convention). */
  onOpenMenu?(): void | Promise<void>;
  /** FASE 7 P2, persistent app header (compact wordmark · persona · posture). */
  header?(): string;
  /** FASE 7 P2, render the live drift gauge segment (the CLI owns the theme).
   *  Receives the DriftReport the loop emitted; appended to the status line. */
  driftSegment?(report: unknown): string;
  /** FASE 7 P2, lets the in-app drift view read sparkline/log detail. */
  personaPath?: string;
}
