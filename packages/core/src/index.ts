/**
 * @personaxis/core, the governed Living-Persona engine.
 *
 * Framework-agnostic, spec-faithful primitives shared by every entry point
 * (CLI REPL, MCP server, TUI, HTTP). The engine never prints; it emits events.
 */

export * from "./persona.js";
export * from "./lock.js";
export * from "./envelopes.js";
export * from "./math/uspace.js";
export * from "./math/bands.js";
export * from "./math/drift.js";
export * from "./math/homeostasis.js";
export * from "./math/arbitration.js";
export * from "./math/jacobian.js";
export * from "./math/structural-drift.js";
export * from "./genesis/index.js";
export * from "./state-engine.js";
export * from "./state-rebuild.js";
export * from "./spec-edit.js";
export * from "./appraisal.js";
export * from "./evolution-view.js";
export * from "./heuristic-appraiser.js";
export * from "./llm-appraiser.js";
export * from "./responder.js";
export * from "./governance.js";
export * from "./verification.js";
export * from "./self-evolution.js";
export * from "./recompile-marker.js";
export * from "./registry.js";
export * from "./presence.js";
export * from "./lease.js";
export * from "./device.js";
export * from "./multi-device.js";
export * from "./home.js";
export * from "./model-config.js";
export * from "./blackboard.js";
export * from "./live-sync.js";
export * from "./sync.js";
export * from "./skill-review.js";
export * from "./skill-lifecycle.js";
export * from "./memory.js";
export * from "./memory-kinds.js";
export * from "./memory/knobs.js";
export * from "./memory/facts.js";
export * from "./memory/retrieval.js";
export * from "./memory/consolidate.js";
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
export * from "./tools/define.js";
export * from "./tools/mcp-adapter.js";
export * from "./loop-breaker.js";
export * from "./planner.js";
// J.4c: reading a model plan and deciding what the run does with the verdict. Separate from
// the planner, which only answers whether the steps would be allowed.
export * from "./plan-phase.js";
export * from "./plan-run.js";
// G6/J.7: measured regression between eval runs, and the causal trace a post-mortem reads.
export * from "./regression.js";
export * from "./causal-trace.js";
export * from "./skill-guide.js";
export * from "./skill-activation.js";
export * from "./skill-writer.js";
export * from "./postmortem.js";
export * from "./task-state.js";
export * from "./tool-output-store.js";
export * from "./security/forensic-log.js";
export * from "./security/interceptor.js";
export * from "./security/watchdog.js";
export * from "./security/ingest.js";
export * from "./security/isolation.js";
export * from "./security/consent.js";
export * from "./security/provenance.js";
export * from "./security/mcp-provenance.js";
export * from "./tool-calling.js";
export * from "./agent.js";

export * from "./wire/adapter.js";
export * from "./wire/record.js";
export * from "./wire/redact.js";
export * from "./enforcement/action-classes.js";
export * from "./enforcement/egress.js";
export * from "./enforcement/policy-compile.js";
export * from "./enforcement/policy-from-persona.js";

export { CORE_VERSION } from "./generated/version.js";

/**
 * The kernel, under a name of its own.
 *
 * A namespace rather than a flat re-export, for two reasons. It runs beside the
 * existing engine and does not replace anything yet, so a reader should be able to
 * tell at the call site which world a symbol comes from. And its vocabulary is
 * generic on purpose (`event`, `Component`, `serviceKey`), which is exactly the
 * vocabulary that collides with everything when it is spread flat.
 */
export * as kernel from "./kernel/index.js";
