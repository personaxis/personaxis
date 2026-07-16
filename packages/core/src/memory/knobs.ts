/**
 * Spec-declared memory knobs, READ AND HONORED (V2-F1.6). Before this module the
 * schema carried `runtime.memory.*`, `memory.write_policy`, `memory.consolidation_policy`,
 * `memory.anchors` and `memory.working_self` but no code consumed them (decorative
 * numbers, the exact failure the jacobian gate exists to prevent). Every reader here
 * has at least one consumer in the engine; defaults are the documented assumptions
 * (SPEC is silent on defaults, so the conservative reading is recorded per field).
 */

export interface MemoryKnobs {
  /** Retrieval context bound (runtime.memory.max_items). Assumption: default 20. */
  maxItems: number;
  /** Rank retrieval by embeddings when the model endpoint serves them (fallback: lexical). */
  useEmbeddings: boolean;
  /** Re-rank the lexical top-k with the chat model when one is configured. */
  useReranker: boolean;
  /** Retention window in days for un-anchored episodic entries; undefined = keep forever. */
  retentionDays?: number;
}

export type WritePolicyDefault = "ephemeral" | "session" | "persistent";

export interface WritePolicy {
  /** Assumption: absent block = "persistent" (the pre-V2 behavior, so old personas are unchanged). */
  default: WritePolicyDefault;
  requires: string[];
}

export type ConsolidationMode = "manual" | "assisted" | "auto";

function num(v: unknown, dflt: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.floor(v) : dflt;
}

export function readMemoryKnobs(frontmatter: Record<string, unknown>): MemoryKnobs {
  const rt = (frontmatter.runtime ?? {}) as { memory?: Record<string, unknown> };
  const m = rt.memory ?? {};
  return {
    maxItems: num(m.max_items, 20),
    useEmbeddings: m.use_embeddings === true,
    useReranker: m.use_reranker === true,
    retentionDays: typeof m.retention_days_default === "number" && m.retention_days_default >= 1 ? Math.floor(m.retention_days_default) : undefined,
  };
}

export function readWritePolicy(frontmatter: Record<string, unknown>): WritePolicy {
  const mem = (frontmatter.memory ?? {}) as { write_policy?: { default?: string; persistent_requires?: unknown[] } };
  const wp = mem.write_policy;
  const dflt = wp?.default === "ephemeral" || wp?.default === "session" || wp?.default === "persistent" ? wp.default : "persistent";
  return { default: dflt, requires: Array.isArray(wp?.persistent_requires) ? wp.persistent_requires.filter((x): x is string => typeof x === "string") : [] };
}

/** Assumption: absent block = "auto" (the pre-V2 behavior: consolidation ran unconditionally). */
export function readConsolidationMode(frontmatter: Record<string, unknown>): ConsolidationMode {
  const mem = (frontmatter.memory ?? {}) as { consolidation_policy?: { mode?: string } };
  const m = mem.consolidation_policy?.mode;
  return m === "manual" || m === "assisted" || m === "auto" ? m : "auto";
}

/** memory.anchors: facts that must always be in context and are never pruned. */
export function readAnchors(frontmatter: Record<string, unknown>): string[] {
  const mem = (frontmatter.memory ?? {}) as { anchors?: unknown[] };
  return Array.isArray(mem.anchors) ? mem.anchors.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];
}

/** memory.working_self: the persona's one-line self-model, injected into context. */
export function readWorkingSelf(frontmatter: Record<string, unknown>): string | undefined {
  const mem = (frontmatter.memory ?? {}) as { working_self?: unknown };
  return typeof mem.working_self === "string" && mem.working_self.trim() ? mem.working_self.trim() : undefined;
}
