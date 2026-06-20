/**
 * Envelope discovery — the spec's bounded-mutability primitive.
 *
 * Every mutable runtime field (personality traits, core affect, mood) declares
 * a `{ mean, range: [min, max] }` envelope in the persona frontmatter. Current
 * values live in state.json and are clamped to these ranges on every mutation.
 *
 * Keys are dot-notation, identical to state.json `values` keys:
 *   traits.<name> | affect.<dim> | mood.<dim>
 */

import type { PersonaFrontmatter } from "./persona.js";

export interface Envelope {
  mean: number;
  min: number;
  max: number;
}

export interface EnvelopeLookup {
  envelopes: Record<string, Envelope>;
  /** Virtues whose enforcement is "hard" — never mutable at runtime. */
  hardEnforcedVirtues: string[];
}

function readEnv(
  v: unknown,
): { mean: number; range: [number, number] } | null {
  if (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { mean?: unknown }).mean === "number" &&
    Array.isArray((v as { range?: unknown }).range) &&
    (v as { range: unknown[] }).range.length === 2
  ) {
    const e = v as { mean: number; range: [number, number] };
    return { mean: e.mean, range: e.range };
  }
  return null;
}

export function extractEnvelopes(data: PersonaFrontmatter): EnvelopeLookup {
  const envelopes: Record<string, Envelope> = {};
  const hardEnforcedVirtues: string[] = [];

  const personality = data.personality as
    | { traits?: Record<string, unknown> }
    | undefined;
  for (const [name, t] of Object.entries(personality?.traits ?? {})) {
    const e = readEnv(t);
    if (e) envelopes[`traits.${name}`] = { mean: e.mean, min: e.range[0], max: e.range[1] };
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
    if (e) envelopes[`affect.${dim}`] = { mean: e.mean, min: e.range[0], max: e.range[1] };
  }
  for (const [dim, env] of Object.entries(affect?.baseline?.mood ?? {})) {
    const e = readEnv(env);
    if (e) envelopes[`mood.${dim}`] = { mean: e.mean, min: e.range[0], max: e.range[1] };
  }

  const character = data.character as
    | { virtues?: Record<string, { enforcement?: string }> }
    | undefined;
  for (const [name, v] of Object.entries(character?.virtues ?? {})) {
    if (v?.enforcement === "hard") hardEnforcedVirtues.push(name);
  }

  return { envelopes, hardEnforcedVirtues };
}
