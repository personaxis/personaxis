/**
 * Action authority (V9 / G.3): resolve, for one edit target, whether it applies DIRECTLY, queues
 * as a governed PROPOSAL, or is BLOCKED, and why. The Command Center never offers an edit it
 * cannot make; it shows the authority instead.
 *
 * This does not invent a permission model. It reads the engine's, in the spec's order:
 *   - numeric envelope coordinates are runtime state, editable (envelope-clamped) unless a hard
 *     virtue backs them (`protectedFields`);
 *   - qualitative spec targets go through the engine's `editGate`, which composes the safety floor
 *     (`isProtected`: identity/character/safety/hard limits/governance/permissions, never editable),
 *     the author's `per_layer_edit_policy`, and the `improvement_policy.mode`.
 *
 * So a change to `improvement_policy.mode` in a persona changes what the Center offers, correctly,
 * with no code here to keep in sync.
 */

import { editGate, isProtected, readMode, type ImprovementMode } from "@personaxis/core";

export type Effect = "direct" | "proposal" | "blocked" | "navigate";

export interface Authority {
  effect: Effect;
  reason: string;
}

/** A numeric envelope coordinate: editable (clamped) unless a hard virtue protects it. */
export function numericFieldEffect(key: string, protectedKeys: readonly string[]): Authority {
  return protectedKeys.includes(key)
    ? { effect: "blocked", reason: "protected: a hard virtue backs this coordinate; read-only" }
    : { effect: "direct", reason: "envelope-clamped mutation (reversible, audited)" };
}

/**
 * A qualitative spec target (a whole layer, or a dot-path into one), resolved by the engine's
 * `editGate`. `block → blocked`, `queue → proposal`, `auto → direct`.
 */
export function qualitativeEffect(targetPath: string, frontmatter: Record<string, unknown>, mode?: ImprovementMode): Authority {
  const m = mode ?? readMode(frontmatter);
  const layer = targetPath.split(".")[0];
  switch (editGate(targetPath, frontmatter, m)) {
    case "block":
      return {
        effect: "blocked",
        reason: isProtected(targetPath)
          ? "protected: safety floor (identity / character / safety / hard limits); never editable"
          : `locked: policy blocks edits to ${layer}`,
      };
    case "queue":
      return { effect: "proposal", reason: `governed: edits to ${layer} queue for review (Evolution / Review)` };
    case "auto":
      return { effect: "direct", reason: `autonomous: edits to ${layer} apply directly (still verified)` };
  }
}

/** The 10 canonical layers, for the Permissions facet's per-layer view. */
export const CANONICAL_LAYERS = [
  "identity",
  "character",
  "personality",
  "values_and_drives",
  "affect",
  "cognition",
  "memory",
  "metacognition",
  "self_regulation",
  "persona",
] as const;
