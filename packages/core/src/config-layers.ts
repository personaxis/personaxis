/**
 * FR.5, explicit numeric configuration-layer precedence.
 *
 * The Codex `config_layer_source` pattern (converging with Claude Code's
 * managed→user deny-wins): every configurable value belongs to a LAYER with a
 * numeric rank; higher rank wins, and the winner is ATTRIBUTABLE (a host can
 * always answer "why is this value in effect?").
 *
 * Two tiers of keys:
 *   - ordinary keys  → highest layer wins (resolveLayered);
 *   - POLICY-TIER keys → a lower layer may only RESTRICT, never relax
 *     (resolvePolicyTier, strictest-wins), the generalization of the
 *     improvement-mode min-wins rule (SPEC.md §7.2).
 */

export const CONFIG_LAYERS = {
  /** Org-managed defaults (reserved, MDM/enterprise distribution). */
  managed: 0,
  /** ~/.personaxis/config.json */
  global: 10,
  /** <project>/.personaxis/config.json */
  project: 20,
  /** per-persona settings (config.json personas.<slug> section) */
  persona: 25,
  /** the persona document's own frontmatter (runtime block) */
  frontmatter: 28,
  /** PERSONAXIS_* environment variables / session flags */
  env: 30,
} as const;

export type ConfigLayer = keyof typeof CONFIG_LAYERS;

export interface LayeredValue<T> {
  value: T;
  /** The layer that supplied the winning value. */
  source: ConfigLayer;
}

/** Highest-ranked defined layer wins. Undefined when no layer defines it. */
export function resolveLayered<T>(
  values: Partial<Record<ConfigLayer, T | undefined>>,
): LayeredValue<T> | undefined {
  let winner: LayeredValue<T> | undefined;
  for (const [layer, rank] of Object.entries(CONFIG_LAYERS) as Array<[ConfigLayer, number]>) {
    const v = values[layer];
    if (v === undefined) continue;
    if (!winner || rank >= CONFIG_LAYERS[winner.source]) winner = { value: v, source: layer };
  }
  return winner;
}

/**
 * Policy-tier resolution: the value is ordered by `strictness` (index 0 =
 * most permissive) and the STRICTEST defined layer wins regardless of rank, 
 * a lower layer can tighten what a higher layer set, never loosen it.
 */
export function resolvePolicyTier<T>(
  values: Partial<Record<ConfigLayer, T | undefined>>,
  strictness: readonly T[],
): LayeredValue<T> | undefined {
  let winner: LayeredValue<T> | undefined;
  for (const layer of Object.keys(CONFIG_LAYERS) as ConfigLayer[]) {
    const v = values[layer];
    if (v === undefined) continue;
    const idx = strictness.indexOf(v);
    if (idx === -1) continue; // unknown value: never wins a policy decision
    if (!winner || idx > strictness.indexOf(winner.value)) winner = { value: v, source: layer };
  }
  return winner;
}
