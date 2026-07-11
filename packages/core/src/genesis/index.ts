/**
 * Genesis orchestrator, merge evidence from any combination of entry modes
 * into one seed, build the valid-by-construction document, and hand back the
 * full result (spec + document + seed + ledger) for the CLI's gates.
 *
 * Merge rule (docs/architecture/genesis.md §2): later sources win per field;
 * every override stays visible in the ledger (both evidence items remain).
 */

import { buildSpecDocument } from "./spec-builder.js";
import { fillSeedExpressions } from "./expression-synth.js";
import type { EvidenceItem, EvidenceLedger, GenesisResult, PersonaSeed } from "./types.js";

export * from "./types.js";
export * from "./spec-builder.js";
export * from "./item-bank.js";
export * from "./interview.js";
export * from "./imports.js";
export * from "./seed-extract.js";
export * from "./report.js";
export * from "./expression-synth.js";

export interface SeedContribution {
  label: string;
  seed: Partial<PersonaSeed>;
  evidence: EvidenceItem[];
}

const EMPTY_SEED: PersonaSeed = {
  slug: "persona",
  displayName: "Persona",
  description: "",
  role: "assistant",
  purpose: "",
  traits: {},
  values: {},
  virtues: {},
  hardLimits: [],
  prohibitedBehaviors: [],
  goals: [],
  antiGoals: [],
};

/** Merge contributions in order (later wins per scalar; maps/lists union). */
export function mergeSeed(contributions: SeedContribution[]): { seed: PersonaSeed; ledger: EvidenceLedger } {
  const seed: PersonaSeed = structuredClone(EMPTY_SEED);
  const ledger: EvidenceLedger = { items: [] };
  for (const c of contributions) {
    const target = seed as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(c.seed)) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) {
        const cur = (target[k] as unknown[]) ?? [];
        target[k] = [...cur, ...v];
      } else if (typeof v === "object") {
        target[k] = { ...((target[k] as object) ?? {}), ...(v as object) };
      } else {
        target[k] = v;
      }
    }
    ledger.items.push(...c.evidence.map((e) => ({ ...e, id: `${c.label}:${e.id}` })));
  }
  return { seed, ledger };
}

/** The whole pipeline minus I/O and validation (which live in the CLI). */
export function genesis(contributions: SeedContribution[]): GenesisResult {
  const { seed, ledger } = mergeSeed(contributions);
  // FASE 7 P1 (gap G1): no number leaves Genesis decorative. Every trait that
  // lacks load-bearing band prose gets the deterministic construct table, and
  // the ledger records it as kind "synthesis" (never passed off as earned).
  ledger.items.push(...fillSeedExpressions(seed));
  const { spec, document } = buildSpecDocument(seed);
  return { spec, document, seed, ledger };
}
