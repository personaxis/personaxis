/**
 * @personaxis/tui/ink, the Ink 7 surface (FR.3).
 *
 * Brand components wrap visual.ts verbatim (zero visual change); Transcript
 * implements the streaming architecture (<Static> + live region + CommitQueue);
 * the store adapts protocol events for React. `screen.ts` (the pre-Ink REPL
 * line editor) remains exported until F3.6 rewires the REPL behind the seam.
 */

export { Sigil, AuraBar, EnvelopeBars, Transcript, Dashboard } from "./components.js";
export type { TranscriptProps, DashboardProps } from "./components.js";
export { CommitQueue } from "./streaming/commit-queue.js";
export { renderMarkdown, highlightCode, renderDiff } from "./markdown.js";
export { createEngineStore, type EngineStore, type EngineUiState } from "./store.js";
export { InkScreen, ReplApp, createReplStore, type ReplUiState } from "./ink-repl.js";
