/**
 * @personaxis/core — the governed Living-Persona engine.
 *
 * Framework-agnostic, spec-faithful primitives shared by every entry point
 * (CLI REPL, MCP server, TUI, HTTP). The engine never prints; it emits events.
 */

export * from "./persona.js";
export * from "./lock.js";
export * from "./envelopes.js";
export * from "./state-engine.js";
export * from "./appraisal.js";
export * from "./heuristic-appraiser.js";
export * from "./llm-appraiser.js";
export * from "./responder.js";
export * from "./governance.js";
export * from "./verification.js";
export * from "./self-evolution.js";
export * from "./recompile-marker.js";
export * from "./registry.js";
export * from "./model-config.js";
export * from "./blackboard.js";
export * from "./live-sync.js";
export * from "./sync.js";
export * from "./skill-review.js";
export * from "./skill-lifecycle.js";
export * from "./memory.js";
export * from "./memory-kinds.js";
export * from "./sessions.js";
export * from "./session-writer.js";
export * from "./provenance.js";
export * from "./injection.js";
export * from "./config-scan.js";
export * from "./config-layers.js";
export * from "./compile/index.js";
export * from "./ports/index.js";
export * from "./sandbox.js";
export * from "./hooks.js";
export * from "./approval.js";
export * from "./tool-repair.js";
export * from "./sigil.js";
export * from "./persona-theme.js";
export * from "./events.js";
export * from "./context.js";
export * from "./trace.js";
export * from "./loop.js";
export * from "./tools/exec.js";
export * from "./tools/registry.js";
export * from "./tool-calling.js";
export * from "./agent.js";

export { CORE_VERSION } from "./generated/version.js";
