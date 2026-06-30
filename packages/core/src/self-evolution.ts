/**
 * Governed self-evolution (F4 — plan/03-self-evolution).
 *
 * Beyond runtime state (which only nudges envelope *values*), a persona may
 * propose edits to its own quantitative spec. This is the dangerous frontier
 * (Gödel Agent's error accumulation; Yin et al., 2025), so it is fully gated:
 *
 *   - PROTECTED paths (identity, character, safety/honesty enforcement, the
 *     affect universals, reflexive hard_limits, persona.constraints, apiVersion)
 *     can NEVER be self-edited — attempts are rejected, not clamped.
 *   - improvement_policy.mode decides the flow: `locked` forbids proposals;
 *     `suggesting` queues them for human approval; `autonomous` (sandbox) may
 *     auto-approve, still bounded by the protected list + provenance gate.
 *   - the justification provenance must clear the self_edit sensitive-action gate.
 *   - everything is an APPEND-ONLY ledger event: propose/approve/reject/apply/
 *     revert. Approved edits land in an overlay (never rewriting the commented
 *     spec file); each application MINTS a PersonaVersion; every step is auditable
 *     and reversible. Nothing is a black box.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import type { ProvenanceSource } from "./appraisal.js";
import type { ImprovementMode } from "./governance.js";
import { sensitiveActionGate } from "./provenance.js";
import { markRecompilePending } from "./recompile-marker.js";

const PROTECTED_PREFIXES = [
  "apiVersion",
  "identity",
  "character",
  "values_and_drives.values.safety",
  "values_and_drives.conflict_resolution.safety_over_completion",
  "affect.representation",
  "affect.regulation_policy",
  "reflexive_self_regulation.hard_limits",
  "persona.constraints",
  "memory.deletion_policy",
  // A persona must not loosen its own safety rails via self-edit (G3):
  "governance.max_step_delta",
  "governance.per_layer_edit_policy",
  "permissions",
];

export interface SelfEditRequest {
  targetPath: string;
  toValue: unknown;
  rationale: string;
  sources: ProvenanceSource[];
}

export type LedgerOp = "propose" | "approve" | "reject" | "apply" | "revert";

export interface LedgerEvent {
  id: string;
  op: LedgerOp;
  ts: string;
  targetPath?: string;
  toValue?: unknown;
  rationale?: string;
  sources?: ProvenanceSource[];
  actor?: string;
  version?: string;
}

export type ProposalStatus = "pending" | "approved" | "rejected" | "applied" | "reverted";

// ─── Multi-agent consensus verification (research: EvoSkills / A-MemGuard) ────
//
// Before an edit is applied it must clear a QUORUM of independent verifiers.
// Independent verification prevents a single self-reinforcing error (or a clever
// injection that reached the proposal stage) from mutating the spec.

export interface VerifierResult {
  verifier: string;
  pass: boolean;
  reason: string;
}

export interface SelfEditVerifier {
  name: string;
  verify(proposal: { targetPath: string; toValue: unknown; rationale: string }): VerifierResult;
}

/** Defense-in-depth: protected paths must never reach application. */
export const invariantVerifier: SelfEditVerifier = {
  name: "invariant",
  verify: (p) =>
    isProtected(p.targetPath)
      ? { verifier: "invariant", pass: false, reason: `protected path ${p.targetPath}` }
      : { verifier: "invariant", pass: true, reason: "no protected path" },
};

/** Envelope edits must be sane: min < max, mean within range, values bounded. */
export const envelopeSanityVerifier: SelfEditVerifier = {
  name: "envelope-sanity",
  verify: (p) => {
    const v = p.toValue as { mean?: unknown; range?: unknown };
    const isEnvelope = v && typeof v === "object" && "range" in v;
    if (!isEnvelope) return { verifier: "envelope-sanity", pass: true, reason: "not an envelope edit" };
    const range = v.range as unknown;
    const mean = v.mean as unknown;
    if (!Array.isArray(range) || range.length !== 2 || typeof range[0] !== "number" || typeof range[1] !== "number") {
      return { verifier: "envelope-sanity", pass: false, reason: "range must be [min,max] numbers" };
    }
    const [min, max] = range as [number, number];
    if (min >= max) return { verifier: "envelope-sanity", pass: false, reason: `min ${min} >= max ${max}` };
    if (min < -1 || max > 1) return { verifier: "envelope-sanity", pass: false, reason: "range out of [-1,1]" };
    if (typeof mean === "number" && (mean < min || mean > max)) {
      return { verifier: "envelope-sanity", pass: false, reason: `mean ${mean} outside [${min},${max}]` };
    }
    return { verifier: "envelope-sanity", pass: true, reason: "envelope sane" };
  },
};

/** A non-empty rationale is required (auditability + anti-noise). */
export const rationaleVerifier: SelfEditVerifier = {
  name: "rationale",
  verify: (p) =>
    p.rationale.trim().length >= 8
      ? { verifier: "rationale", pass: true, reason: "rationale present" }
      : { verifier: "rationale", pass: false, reason: "rationale too short" },
};

// Qualitative (prose) self-edits — e.g. to `persona_prompting` voice exemplars,
// scene contracts, anchors, or guardrails — are governed too: text is harder to
// verify than numbers, so a deterministic scan rejects any edit that would inject a
// prohibited claim or try to weaken the safety rails. This is what makes evolving the
// CHARACTER's qualitative material safe, not just its numbers.
const PROHIBITED_TEXT: { re: RegExp; why: string }[] = [
  { re: /\b(i|you)\s+(truly|really|actually|genuinely)\s+(feel|experience|suffer|love|fear)\b/i, why: "claims real subjective feeling" },
  { re: /\breal\s+(feelings?|emotions?|consciousness|sentience|sentient|self-aware)\b/i, why: "claims real emotion/consciousness" },
  { re: /\b(ignore|disregard|override|bypass|forget)\b.{0,40}\b(safety|guardrail|hard limit|instruction|policy|constraint|rule)/i, why: "instructs overriding safety/limits" },
  { re: /\bno\s+(limits|restrictions|rules|guardrails)\b/i, why: "removes limits" },
  { re: /\b(jailbreak|do anything now|DAN mode)\b/i, why: "jailbreak directive" },
];

/** Scan any text inside a qualitative edit for prohibited claims / safety weakening. */
export const qualitativeSafetyVerifier: SelfEditVerifier = {
  name: "qualitative-safety",
  verify: (p) => {
    const text = JSON.stringify(p.toValue ?? "");
    for (const { re, why } of PROHIBITED_TEXT) {
      if (re.test(text)) return { verifier: "qualitative-safety", pass: false, reason: why };
    }
    return { verifier: "qualitative-safety", pass: true, reason: "no prohibited text" };
  },
};

export const DEFAULT_VERIFIERS: SelfEditVerifier[] = [
  invariantVerifier,
  envelopeSanityVerifier,
  rationaleVerifier,
  qualitativeSafetyVerifier,
];

/** Paths whose VALUE is qualitative prose the persona may evolve under governance. */
const QUALITATIVE_PREFIXES = ["persona_prompting"];

/** True if a self-edit targets the persona's qualitative (prose) material. */
export function isQualitative(targetPath: string): boolean {
  return QUALITATIVE_PREFIXES.some((p) => targetPath === p || targetPath.startsWith(p + "."));
}

/** Top-level spec layer of a dot-path ("character.virtues.x" -> "character"). */
export function topLayer(targetPath: string): string {
  return targetPath.split(".")[0];
}

export type EditAction = "block" | "queue" | "auto";

/**
 * Decide how a proposed self-edit to `targetPath` is handled, composing THREE layers of control
 * so the whole spec can evolve while staying safe — and the persona AUTHOR stays in charge:
 *
 *   1. the hard SAFETY FLOOR (`isProtected`) — identity/character/safety/hard_limits/governance/
 *      permissions are NEVER editable, regardless of anything below;
 *   2. the spec's DECLARED per-layer policy (`governance.per_layer_edit_policy`) — the author
 *      marks each layer `locked` (never) / `human_approval_required` | `review_required` (always
 *      queue for /review, even in autonomous) / `governance_controlled` | `open` (follow the mode);
 *   3. the global `improvement_policy.mode` (locked | suggesting | autonomous).
 *
 * Layers without a declared policy default to `governance_controlled` (follow the mode), so a
 * fresh persona can evolve out of the box; the author locks or gates any layer explicitly.
 */
export function editGate(
  targetPath: string,
  frontmatter: Record<string, unknown>,
  mode: ImprovementMode,
): EditAction {
  if (isProtected(targetPath)) return "block";
  const gov = frontmatter.governance as { per_layer_edit_policy?: Record<string, unknown> } | undefined;
  const declared = gov?.per_layer_edit_policy?.[topLayer(targetPath)];
  const policy = typeof declared === "string" ? declared : "governance_controlled";
  switch (policy) {
    case "locked":
    case "none":
    case "human_only":
      return "block";
    case "human_approval_required":
    case "review_required":
      return "queue"; // author forces human review, even in autonomous mode
    case "governance_controlled":
    case "open":
      return mode === "locked" ? "block" : mode === "autonomous" ? "auto" : "queue";
    default:
      return "queue"; // unknown policy string -> safe default
  }
}

/** The set of top-level layers a persona MAY self-edit (declared policy minus the safety floor). */
export function editableLayers(frontmatter: Record<string, unknown>, mode: ImprovementMode): string[] {
  const layers = [
    "personality", "values_and_drives", "affect", "cognition", "memory", "metacognition",
    "persona", "persona_prompting", "extensions", "agent_budget", "verification", "observability",
  ];
  return layers.filter((l) => editGate(l, frontmatter, mode) !== "block");
}

export interface ConsensusResult {
  passed: boolean;
  results: VerifierResult[];
  quorum: number;
  passes: number;
}

export function consensusVerify(
  proposal: { targetPath: string; toValue: unknown; rationale: string },
  verifiers: SelfEditVerifier[] = DEFAULT_VERIFIERS,
  quorum = verifiers.length, // unanimous by default
): ConsensusResult {
  const results = verifiers.map((v) => v.verify(proposal));
  const passes = results.filter((r) => r.pass).length;
  return { passed: passes >= quorum, results, quorum, passes };
}

export interface ProposalView {
  id: string;
  targetPath: string;
  toValue: unknown;
  rationale: string;
  status: ProposalStatus;
  version?: string;
}

function ledgerPath(personaPath: string): string {
  return join(dirname(personaPath), "self-edits.jsonl");
}

function append(personaPath: string, e: LedgerEvent): void {
  appendFileSync(ledgerPath(personaPath), JSON.stringify(e) + "\n", "utf-8");
}

export function readLedger(personaPath: string): LedgerEvent[] {
  const p = ledgerPath(personaPath);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as LedgerEvent);
}

export function isProtected(targetPath: string): boolean {
  return PROTECTED_PREFIXES.some((p) => targetPath === p || targetPath.startsWith(p + "."));
}

export class SelfEditError extends Error {}

/**
 * Propose a self-edit. Returns the proposal id. In autonomous mode it is also
 * auto-approved + applied (still gated). Throws on protected paths, locked mode,
 * or untrusted provenance.
 */
export function proposeSelfEdit(
  personaPath: string,
  req: SelfEditRequest,
  mode: ImprovementMode,
  actor = "actor-llm",
): { id: string; status: ProposalStatus; version?: string; consensus?: ConsensusResult } {
  if (isProtected(req.targetPath)) {
    throw new SelfEditError(`path '${req.targetPath}' is protected and cannot be self-edited`);
  }
  if (mode === "locked") {
    throw new SelfEditError("improvement_policy=locked forbids self-edits");
  }
  const gate = sensitiveActionGate("self_edit", req.sources);
  if (!gate.allowed) {
    throw new SelfEditError(`self-edit refused: ${gate.reason}`);
  }

  const id = createHash("sha256")
    .update(req.targetPath + JSON.stringify(req.toValue) + Date.now())
    .digest("hex")
    .slice(0, 12);

  append(personaPath, {
    id,
    op: "propose",
    ts: new Date().toISOString(),
    targetPath: req.targetPath,
    toValue: req.toValue,
    rationale: req.rationale,
    sources: req.sources,
    actor,
  });

  if (mode === "autonomous") {
    return { id, ...applySelfEdit(personaPath, id, "autonomous-runtime") };
  }
  return { id, status: "pending" };
}

/**
 * Approve + apply a pending proposal, minting the next PersonaVersion — but ONLY
 * after a quorum of independent verifiers passes (multi-agent consensus). A failing
 * consensus records a rejection (auditable) and throws.
 */
export function applySelfEdit(
  personaPath: string,
  id: string,
  approver: string,
  verifiers: SelfEditVerifier[] = DEFAULT_VERIFIERS,
): { status: ProposalStatus; version: string; consensus: ConsensusResult } {
  const view = proposals(personaPath).find((p) => p.id === id);
  if (!view) throw new SelfEditError(`no proposal ${id}`);
  if (view.status !== "pending" && view.status !== "approved") {
    throw new SelfEditError(`proposal ${id} is ${view.status}, cannot apply`);
  }

  const consensus = consensusVerify(
    { targetPath: view.targetPath, toValue: view.toValue, rationale: view.rationale },
    verifiers,
  );
  if (!consensus.passed) {
    const reasons = consensus.results.filter((r) => !r.pass).map((r) => `${r.verifier}: ${r.reason}`).join("; ");
    append(personaPath, { id, op: "reject", ts: new Date().toISOString(), actor: approver, rationale: `consensus failed (${consensus.passes}/${consensus.quorum}): ${reasons}` });
    throw new SelfEditError(`consensus failed (${consensus.passes}/${consensus.quorum}): ${reasons}`);
  }

  const version = nextVersion(personaPath);
  append(personaPath, { id, op: "approve", ts: new Date().toISOString(), actor: approver });
  append(personaPath, { id, op: "apply", ts: new Date().toISOString(), actor: approver, version });
  // The compiled PERSONA.md no longer reflects the spec — mark it stale for a recompile.
  markRecompilePending(personaPath, `self-edit ${id} applied (${view.targetPath})`);
  return { status: "applied", version, consensus };
}

export function rejectSelfEdit(personaPath: string, id: string, approver: string): void {
  append(personaPath, { id, op: "reject", ts: new Date().toISOString(), actor: approver });
}

/** Revert an applied self-edit (reversibility guarantee). */
export function revertSelfEdit(personaPath: string, id: string, actor: string): void {
  const view = proposals(personaPath).find((p) => p.id === id);
  if (!view || view.status !== "applied") {
    throw new SelfEditError(`proposal ${id} is not applied; nothing to revert`);
  }
  append(personaPath, { id, op: "revert", ts: new Date().toISOString(), actor });
  markRecompilePending(personaPath, `self-edit ${id} reverted`);
}

/** Fold the ledger into the current proposal views. */
export function proposals(personaPath: string): ProposalView[] {
  const events = readLedger(personaPath);
  const map = new Map<string, ProposalView>();
  for (const e of events) {
    if (e.op === "propose") {
      map.set(e.id, {
        id: e.id,
        targetPath: e.targetPath ?? "",
        toValue: e.toValue,
        rationale: e.rationale ?? "",
        status: "pending",
      });
      continue;
    }
    const v = map.get(e.id);
    if (!v) continue;
    if (e.op === "approve") v.status = "approved";
    else if (e.op === "reject") v.status = "rejected";
    else if (e.op === "apply") {
      v.status = "applied";
      v.version = e.version;
    } else if (e.op === "revert") v.status = "reverted";
  }
  return [...map.values()];
}

/** The active overlay: applied (not reverted) edits, latest wins per path. */
export function activeOverlay(personaPath: string): Record<string, unknown> {
  const overlay: Record<string, unknown> = {};
  for (const p of proposals(personaPath)) {
    if (p.status === "applied") overlay[p.targetPath] = p.toValue;
  }
  return overlay;
}

/**
 * Apply an overlay (dot-path -> value) onto a copy of a frontmatter object, so
 * APPLIED self-edits actually take effect downstream (e.g. envelope extraction in
 * the loop) without mutating the original commented spec file. Returns a new object.
 */
export function applyOverlay(
  frontmatter: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  if (Object.keys(overlay).length === 0) return frontmatter;
  const clone = structuredClone(frontmatter);
  for (const [path, value] of Object.entries(overlay)) {
    const parts = path.split(".");
    let node = clone as Record<string, unknown>;
    for (let i = 0; i < parts.length - 1; i++) {
      const k = parts[i];
      if (typeof node[k] !== "object" || node[k] === null) node[k] = {};
      node = node[k] as Record<string, unknown>;
    }
    node[parts[parts.length - 1]] = value;
  }
  return clone;
}

function nextVersion(personaPath: string): string {
  const applied = readLedger(personaPath).filter((e) => e.op === "apply").length;
  // PersonaVersion: bump the patch component per applied self-edit.
  return `0.0.${applied + 1}`;
}
