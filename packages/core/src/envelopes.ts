/**
 * Envelope discovery — the spec's bounded-mutability primitive.
 *
 * Every mutable runtime field (personality traits, core affect, mood — and, in
 * v1.0, envelope-declaring drives) declares a `{ mean, range: [min, max] }`
 * envelope in the persona frontmatter. Current values live in state.json and are
 * clamped to these ranges on every mutation.
 *
 * Keys are dot-notation, identical to state.json `values` keys. Their form is
 * version-dependent:
 *   spec ≤ 0.10:  traits.<name> | affect.<dim> | mood.<dim>            (short, legacy)
 *   spec 1.0:     personality.traits.<name> | affect.baseline.core_affect.<dim> |
 *                 affect.baseline.mood.<dim> | values_and_drives.drives.<name>  (full dot-paths)
 * `resolveField` maps either form a caller supplies onto the persona's canonical
 * form, so `--field mood.tone` keeps working against a v1.0 persona.
 */

import type { PersonaFrontmatter } from "./persona.js";

export interface Envelope {
  mean: number;
  min: number;
  max: number;
  /** v1.0 behavior bands `[b1, b2]` — boundaries on the raw value axis. Absent →
   *  spec defaults apply (math/bands.ts). Crossing one is the normative drift event. */
  bands?: [number, number];
  /** Per-band behavior prose (normative form) or a plain string (deprecated). The
   *  compiler injects ONLY the current band's variant — Def. 6 / ADR-004. */
  expression?: string | Partial<Record<"low" | "moderate" | "high", string>>;
}

export interface EnvelopeLookup {
  envelopes: Record<string, Envelope>;
  /** Virtues whose enforcement is "hard" — never mutable at runtime. */
  hardEnforcedVirtues: string[];
  /**
   * Exact envelope KEYS that are immutable at runtime. Legacy: traits sharing a
   * hard virtue's name. v1.0: additionally every trait a hard virtue declares in
   * its `refs:` — the composition rule that finally makes `honesty` (virtue) protect
   * `honesty_humility` (trait). Optional for hand-built lookups (tests): when absent
   * the governance gate falls back to the legacy name-match rule.
   */
  protectedFields?: string[];
}

/** True when the frontmatter is a v1.0 document (spec_version 1.x / renamed layer 9). */
export function isV1Frontmatter(data: PersonaFrontmatter): boolean {
  const sv = (data as { spec_version?: unknown }).spec_version;
  if (typeof sv === "string" && sv.startsWith("1.")) return true;
  return (data as { self_regulation?: unknown }).self_regulation !== undefined;
}

/** Short (≤0.10) prefix → full (1.0) prefix for state/envelope keys. */
export const SHORT_TO_FULL: ReadonlyArray<[string, string]> = [
  ["traits.", "personality.traits."],
  ["affect.", "affect.baseline.core_affect."],
  ["mood.", "affect.baseline.mood."],
  ["drives.", "values_and_drives.drives."],
];

/**
 * Resolve a caller-supplied field name (short or full form) onto the key the
 * persona's envelope set actually uses. Returns the input unchanged when no
 * mapping matches — the gate then rejects it with the exact-field message.
 */
export function resolveField(field: string, envelopes: Record<string, Envelope>): string {
  if (field in envelopes) return field;
  for (const [short, full] of SHORT_TO_FULL) {
    if (field.startsWith(short)) {
      const candidate = full + field.slice(short.length);
      if (candidate in envelopes) return candidate;
    }
    if (field.startsWith(full)) {
      const candidate = short + field.slice(full.length);
      if (candidate in envelopes) return candidate;
    }
  }
  return field;
}

function readEnv(v: unknown): Omit<Envelope, "min" | "max"> & { range: [number, number] } | null {
  if (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { mean?: unknown }).mean === "number" &&
    Array.isArray((v as { range?: unknown }).range) &&
    (v as { range: unknown[] }).range.length === 2
  ) {
    const e = v as { mean: number; range: [number, number]; bands?: unknown; expression?: unknown };
    const out: ReturnType<typeof readEnv> = { mean: e.mean, range: e.range };
    // v1.0 denotational fields (F6.2): carried when well-formed, ignored otherwise.
    if (
      Array.isArray(e.bands) &&
      e.bands.length === 2 &&
      typeof e.bands[0] === "number" &&
      typeof e.bands[1] === "number" &&
      e.bands[0] < e.bands[1]
    ) {
      out.bands = [e.bands[0], e.bands[1]];
    }
    if (typeof e.expression === "string") {
      out.expression = e.expression;
    } else if (typeof e.expression === "object" && e.expression !== null) {
      const m = e.expression as Record<string, unknown>;
      const bandMap: Partial<Record<"low" | "moderate" | "high", string>> = {};
      for (const band of ["low", "moderate", "high"] as const) {
        if (typeof m[band] === "string") bandMap[band] = m[band] as string;
      }
      if (Object.keys(bandMap).length > 0) out.expression = bandMap;
    }
    return out;
  }
  return null;
}

/** Spread helper: envelope from a readEnv result. */
function toEnvelope(e: NonNullable<ReturnType<typeof readEnv>>): Envelope {
  const out: Envelope = { mean: e.mean, min: e.range[0], max: e.range[1] };
  if (e.bands) out.bands = e.bands;
  if (e.expression !== undefined) out.expression = e.expression;
  return out;
}

/** Position (0..width-1) of a value within its envelope — shared bar math. */
export function barIndex(value: number, e: Envelope, width: number): number {
  const frac = e.max === e.min ? 0.5 : (value - e.min) / (e.max - e.min);
  return Math.max(0, Math.min(width - 1, Math.round(frac * (width - 1))));
}

export function extractEnvelopes(data: PersonaFrontmatter): EnvelopeLookup {
  const envelopes: Record<string, Envelope> = {};
  const hardEnforcedVirtues: string[] = [];
  const protectedFields: string[] = [];
  const v1 = isV1Frontmatter(data);
  const traitKey = (name: string) => (v1 ? `personality.traits.${name}` : `traits.${name}`);

  const personality = data.personality as
    | { traits?: Record<string, unknown> }
    | undefined;
  for (const [name, t] of Object.entries(personality?.traits ?? {})) {
    const e = readEnv(t);
    if (e) envelopes[traitKey(name)] = toEnvelope(e);
  }

  const affect = data.affect as
    | {
        baseline?: {
          core_affect?: Record<string, unknown>;
          mood?: Record<string, unknown>;
        };
      }
    | undefined;
  for (const [dim, env] of Object.entries(affect?.baseline?.core_affect ?? {})) {
    const e = readEnv(env);
    if (e) envelopes[v1 ? `affect.baseline.core_affect.${dim}` : `affect.${dim}`] = toEnvelope(e);
  }
  for (const [dim, env] of Object.entries(affect?.baseline?.mood ?? {})) {
    const e = readEnv(env);
    if (e) envelopes[v1 ? `affect.baseline.mood.${dim}` : `mood.${dim}`] = toEnvelope(e);
  }

  // v1.0: a drive that declares an envelope joins the mutable surface.
  if (v1) {
    const vad = data.values_and_drives as { drives?: Record<string, unknown> } | undefined;
    for (const [name, d] of Object.entries(vad?.drives ?? {})) {
      const e = readEnv(d);
      if (e) envelopes[`values_and_drives.drives.${name}`] = toEnvelope(e);
    }
  }

  const character = data.character as
    | { virtues?: Record<string, { enforcement?: string; refs?: unknown }> }
    | undefined;
  for (const [name, v] of Object.entries(character?.virtues ?? {})) {
    if (v?.enforcement !== "hard") continue;
    hardEnforcedVirtues.push(name);
    // Legacy rule: a trait sharing the hard virtue's NAME is protected.
    const sameName = traitKey(name);
    if (sameName in envelopes) protectedFields.push(sameName);
    // v1.0 rule: every trait the hard virtue references is protected.
    if (v1 && Array.isArray(v.refs)) {
      for (const ref of v.refs) {
        if (typeof ref !== "string") continue;
        const key = resolveField(ref, envelopes);
        if (key in envelopes && key.includes("traits.") && !protectedFields.includes(key)) {
          protectedFields.push(key);
        }
      }
    }
  }

  return { envelopes, hardEnforcedVirtues, protectedFields };
}
