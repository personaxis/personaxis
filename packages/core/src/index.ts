/**
 * @personaxis/core — the governed Living-Persona engine.
 *
 * Framework-agnostic, spec-faithful primitives shared by every entry point
 * (CLI REPL, MCP server, TUI, HTTP). The engine never prints; it emits events.
 */

export * from "./persona.js";
export * from "./envelopes.js";
export * from "./state-engine.js";
export * from "./appraisal.js";
export * from "./heuristic-appraiser.js";
export * from "./llm-appraiser.js";
export * from "./responder.js";
export * from "./governance.js";
export * from "./verification.js";
export * from "./self-evolution.js";
export * from "./registry.js";
export * from "./blackboard.js";
export * from "./live-sync.js";
export * from "./sync.js";
export * from "./skill-review.js";
export * from "./skill-lifecycle.js";
export * from "./memory.js";
export * from "./provenance.js";
export * from "./injection.js";
export * from "./sandbox.js";
export * from "./sigil.js";
export * from "./persona-theme.js";
export * from "./events.js";
export * from "./loop.js";
export * from "./tools/exec.js";
export * from "./tools/registry.js";
export * from "./tool-calling.js";
export * from "./agent.js";

export const CORE_VERSION = "0.7.0";
