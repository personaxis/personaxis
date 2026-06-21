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
): { id: string; status: ProposalStatus; version?: string } {
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

/** Approve + apply a pending proposal, minting the next PersonaVersion. */
export function applySelfEdit(
  personaPath: string,
  id: string,
  approver: string,
): { status: ProposalStatus; version: string } {
  const view = proposals(personaPath).find((p) => p.id === id);
  if (!view) throw new SelfEditError(`no proposal ${id}`);
  if (view.status !== "pending" && view.status !== "approved") {
    throw new SelfEditError(`proposal ${id} is ${view.status}, cannot apply`);
  }
  const version = nextVersion(personaPath);
  append(personaPath, { id, op: "approve", ts: new Date().toISOString(), actor: approver });
  append(personaPath, { id, op: "apply", ts: new Date().toISOString(), actor: approver, version });
  return { status: "applied", version };
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

function nextVersion(personaPath: string): string {
  const applied = readLedger(personaPath).filter((e) => e.op === "apply").length;
  // PersonaVersion: bump the patch component per applied self-edit.
  return `0.0.${applied + 1}`;
}
