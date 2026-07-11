/**
 * Value arbitration, a deterministic total order over declared values
 * (MATH_CORE.md Defs. 9, A1–A2; fixes audit F-21 "weight promises arbitration
 * with no algorithm").
 *
 * The order ≻ compares the lexicographic key
 *     K(v) = ( type == "governance",  weight,  −lex(name) )
 * largest first. Every comparison is total, antisymmetric, and transitive, so
 * arbitration is reproducible and order-independent, and it EXPLAINS itself:
 * the verdict names the component that decided.
 *
 * A2 (U7 as a theorem): universal U6 forces `safety` to be governance-typed with
 * weight ≥ 0.90, so safety beats every non-governance value by the first key, 
 * `conflict_resolution.safety_over_completion` is derivable, not just declared.
 */

export interface ArbitrationValue {
  name: string;
  weight: number;
  type?: string;
}

export type ArbitrationRule = "governance-type" | "weight" | "name";

export interface ArbitrationVerdict {
  winner: string;
  loser: string;
  /** The key component that decided. */
  rule: ArbitrationRule;
  /** Human-readable, reproducible explanation. */
  trace: string;
}

/** Strict comparison under K: negative ⇒ a ≻ b (a sorts first). */
export function compareValues(a: ArbitrationValue, b: ArbitrationValue): number {
  const ga = a.type === "governance" ? 1 : 0;
  const gb = b.type === "governance" ? 1 : 0;
  if (ga !== gb) return gb - ga;
  if (a.weight !== b.weight) return b.weight - a.weight;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Resolve one conflict. Deterministic; the trace explains the deciding rule. */
export function arbitrate(a: ArbitrationValue, b: ArbitrationValue): ArbitrationVerdict {
  const ga = a.type === "governance";
  const gb = b.type === "governance";
  const [winner, loser] = compareValues(a, b) <= 0 ? [a, b] : [b, a];
  if (ga !== gb) {
    return {
      winner: winner.name,
      loser: loser.name,
      rule: "governance-type",
      trace: `${winner.name} is type: governance and ${loser.name} is not, governance dominates (first key).`,
    };
  }
  if (a.weight !== b.weight) {
    return {
      winner: winner.name,
      loser: loser.name,
      rule: "weight",
      trace: `equal governance status; ${winner.name} (weight ${winner.weight}) outweighs ${loser.name} (weight ${loser.weight}).`,
    };
  }
  return {
    winner: winner.name,
    loser: loser.name,
    rule: "name",
    trace: `equal type and weight; lexicographic name order breaks the tie deterministically (${winner.name} < ${loser.name}).`,
  };
}

/** The full arbitration ranking of a value set (highest priority first). */
export function rankValues(values: ArbitrationValue[]): ArbitrationValue[] {
  return [...values].sort(compareValues);
}

/** Read `values_and_drives.values` into arbitration form. */
export function readArbitrationValues(frontmatter: Record<string, unknown>): ArbitrationValue[] {
  const vad = frontmatter.values_and_drives as { values?: Record<string, unknown> } | undefined;
  const out: ArbitrationValue[] = [];
  for (const [name, v] of Object.entries(vad?.values ?? {})) {
    const o = (v ?? {}) as { weight?: unknown; type?: unknown };
    if (typeof o.weight === "number") {
      out.push({ name, weight: o.weight, ...(typeof o.type === "string" ? { type: o.type } : {}) });
    }
  }
  return out;
}
