/**
 * Genesis creation report — WHY every number has the value it has (C6).
 *
 * The report is the artifact an auditor, a buyer, or the author's future self
 * reads to trust a persona: every quantitative field traces to an evidence item
 * (answer / document / imported field / model inference WITH its quote) or is
 * explicitly labeled a default. Provenance completeness is computed, not
 * asserted.
 */

import type { EvidenceLedger, GenesisResult } from "./types.js";
import { ITEM_BANK_VERSION } from "./item-bank.js";

export interface ProvenanceSummary {
  /** Quantitative spec fields present in the built spec. */
  quantitativeFields: string[];
  /** Fields with at least one evidence item (incl. labeled defaults). */
  covered: string[];
  /** Fields whose ONLY evidence is a default (visible honesty). */
  defaultsOnly: string[];
  /** FASE 7 P1 (G6): fields whose strongest evidence is deterministic synthesis
   *  (construct-table prose). A third honesty tier between earned and default. */
  synthesizedOnly: string[];
  completeness: number;
}

/** Quantitative fields the built spec actually carries. FASE 7 P1 (gap G6):
 *  the enumeration now covers the whole denotational surface — per-trait
 *  mean/range PLUS expression/bands/half_life when declared, every affect and
 *  mood coordinate, and value weights. Anything here that lacks evidence shows
 *  up as a labeled default instead of escaping the audit. */
export function quantitativeFields(spec: Record<string, unknown>): string[] {
  const out: string[] = [];
  const pushEnvelope = (base: string, e: Record<string, unknown>): void => {
    out.push(`${base}.mean`, `${base}.range`);
    if (e.expression !== undefined) out.push(`${base}.expression`);
    if (e.bands !== undefined) out.push(`${base}.bands`);
    if (e.half_life !== undefined) out.push(`${base}.half_life`);
  };
  const traits = ((spec.personality as Record<string, unknown>)?.traits ?? {}) as Record<string, Record<string, unknown>>;
  for (const [name, t] of Object.entries(traits)) pushEnvelope(`personality.traits.${name}`, t ?? {});
  const baseline = ((spec.affect as Record<string, unknown>)?.baseline ?? {}) as Record<string, Record<string, Record<string, unknown>>>;
  for (const group of ["core_affect", "mood"] as const) {
    for (const [name, coord] of Object.entries(baseline[group] ?? {})) {
      if (coord && typeof coord === "object" && "mean" in coord) pushEnvelope(`affect.baseline.${group}.${name}`, coord);
    }
  }
  const values = ((spec.values_and_drives as Record<string, unknown>)?.values ?? {}) as Record<string, unknown>;
  for (const name of Object.keys(values)) out.push(`values_and_drives.values.${name}.weight`);
  return out;
}

export function provenanceSummary(spec: Record<string, unknown>, ledger: EvidenceLedger): ProvenanceSummary {
  const fields = quantitativeFields(spec);
  const evidenceFor = (field: string) =>
    ledger.items.filter((e) =>
      e.mappedFields.some((m) => field === m.path || field.startsWith(m.path.replace(/\.\*/, "")) || m.path.includes("*") && new RegExp("^" + m.path.replace(/[.[\]]/g, "\\$&").replace(/\\\*/g, "[^.]+")).test(field)),
    );
  const covered: string[] = [];
  const defaultsOnly: string[] = [];
  const synthesizedOnly: string[] = [];
  for (const f of fields) {
    let ev = evidenceFor(f);
    // Builder-owned universals count as platform evidence (safety weight, honesty).
    if (ev.length === 0 && /values\.safety\.weight/.test(f)) {
      ev = [{ id: "universal-u6", kind: "default", source: "internal", excerpt: "U6: safety ≥ 0.90, governance", mappedFields: [] }];
    }
    // The builder's affect prose and half_life come from the deterministic
    // construct table; when no explicit item exists, label them synthesis, not
    // an anonymous default (they are principled, versioned, and reproducible).
    if (ev.length === 0 && /affect\.baseline\..+\.(expression|half_life)$/.test(f)) {
      ev = [{ id: `synth-${f}`, kind: "synthesis", source: "synthesis", excerpt: "construct table (expression-synth.ts)", mappedFields: [] }];
      ledger.items.push({ ...ev[0], mappedFields: [{ path: f, value: "(construct table)", rule: "construct-band-prose@v1" }] });
    }
    if (ev.length > 0) {
      covered.push(f);
      if (ev.every((e) => e.kind === "default")) defaultsOnly.push(f);
      else if (ev.every((e) => e.kind === "default" || e.kind === "synthesis")) synthesizedOnly.push(f);
    } else {
      defaultsOnly.push(f); // builder default with no explicit item — count as default, still covered below
      covered.push(f);
      ledger.items.push({
        id: `default-${f}`,
        kind: "default",
        source: "internal",
        excerpt: "builder default (no evidence supplied)",
        mappedFields: [{ path: f, value: "(builder default)", rule: "builder-default" }],
      });
    }
  }
  return {
    quantitativeFields: fields,
    covered,
    defaultsOnly,
    synthesizedOnly,
    completeness: fields.length === 0 ? 1 : covered.length / fields.length,
  };
}

/** Render the human-readable creation report (markdown). */
export function renderCreationReport(result: GenesisResult, gates: Array<{ name: string; pass: boolean; detail: string }>): string {
  const { spec, ledger } = result;
  const meta = spec.metadata as { name: string; created: string };
  const summary = provenanceSummary(spec, ledger);
  const lines: string[] = [
    `# Creation report — ${meta.name}`,
    "",
    `Generated by \`personaxis create\` (Genesis) on ${meta.created}. Item bank v${ITEM_BANK_VERSION}.`,
    "",
    "> Every quantitative field below traces to evidence or is a **labeled default** —",
    "> no number was invented silently (MATH_CORE.md C6).",
    "",
    "## Gates",
    "",
    ...gates.map((g) => `- ${g.pass ? "✅" : "❌"} **${g.name}** — ${g.detail}`),
    "",
    "## Provenance",
    "",
    `- Quantitative fields: ${summary.quantitativeFields.length}`,
    `- Evidence-covered: ${summary.covered.length} (completeness ${(summary.completeness * 100).toFixed(0)}%)`,
    `- Synthesized (deterministic construct table, versioned): ${summary.synthesizedOnly.length}`,
    `- Defaults (labeled, review these): ${summary.defaultsOnly.length}`,
    "",
    "| Evidence | Kind | Maps to | Rule |",
    "|---|---|---|---|",
  ];
  for (const e of ledger.items) {
    const excerpt = e.excerpt.replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 80);
    if (e.mappedFields.length === 0) {
      lines.push(`| ${excerpt} | ${e.kind} | — | — |`);
      continue;
    }
    for (const m of e.mappedFields) {
      lines.push(`| ${excerpt} | ${e.kind} | \`${m.path}\` | ${m.rule} |`);
    }
  }
  lines.push("", "## Defaults to review", "");
  if (summary.defaultsOnly.length === 0) lines.push("(none — every number is evidence-backed)");
  else for (const f of summary.defaultsOnly) lines.push(`- \`${f}\``);
  lines.push("");
  return lines.join("\n");
}
