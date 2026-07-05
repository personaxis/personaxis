/**
 * F3.1 — the two-stage compile pipeline, framework-agnostic and in core so the
 * Living Loop (inline recompile) and the SaaS (server-side compile) share it
 * with the CLI. Stage 1 (assemble) is deterministic and always runs; stage 2
 * (LLM polish) is optional and validated by the faithfulness check.
 */
export * from "./assemble.js";
export * from "./faithfulness.js";
export * from "./targets.js";
export * from "./dist.js";
