/**
 * The compile pipeline, framework-agnostic and in core so the CLI and a hosted engine share it: the
 * reference the code assembles from the spec, the faithfulness check a model's document is held to, the
 * placement targets, and the history of every version written (since 2026-10-07 a model writes the
 * document and the reference is never written as one).
 */
export * from "./assemble.js";
export * from "./faithfulness.js";
export * from "./targets.js";
export * from "./dist.js";
export * from "./history.js";
