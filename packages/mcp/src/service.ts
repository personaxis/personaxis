/**
 * Persona service, the MCP boundary over the @personaxis/sdk façade (F3.5).
 *
 * The engine operations (observe, adjust, audit, agent, forget, self-edits,
 * scans) live ONCE, in the SDK. This module is the MCP-specific wrapper: it
 * (1) CONFINES every persona/skill path to the server root (ADR-011), and
 * (2) adapts the SDK's typed results into the MCP tools' snake_case wire shapes.
 * It no longer re-implements the clamp/audit/loop/agent logic, that duplication
 * (the old service.ts ≈ sdk/index.ts) is gone.
 */

import {
  Persona,
  scanText as sdkScanText,
  scanConfig as sdkScanConfig,
  skillReview as sdkSkillReview,
  evaluateCmd as sdkEvaluateCmd,
} from "@personaxis/sdk";
import { loadPersona, ensureState, extractEnvelopes, touchPresence, type ProvenanceSource } from "@personaxis/core";
import { resolve as presolve, relative, isAbsolute } from "node:path";

// ── Path confinement (ADR-011: --root) ──────────────────────────────────────
// When a root is set (the stdio server ALWAYS sets one, the --root flag or its
// cwd default), every persona/skill path the MCP client supplies must resolve
// inside it: an MCP client must not be able to read or mutate arbitrary
// filesystem personas. Library/test embedders that call service functions
// directly without setRoot() keep plain path resolution.
let confineRoot: string | null = null;

export function setRoot(dir: string): void {
  confineRoot = presolve(dir);
}

export function confine(p: string): string {
  const abs = presolve(confineRoot ?? process.cwd(), p);
  if (confineRoot) {
    const rel = relative(confineRoot, abs);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(
        `persona path escapes the server root (${confineRoot}): '${p}'. ` +
          `Start personaxis-mcp with --root <dir> to serve personas outside the current directory.`,
      );
    }
  }
  return abs;
}

/**
 * Confine a path that names a PERSONA, and record that this server is driving it.
 *
 * D6: the MCP server holds no persona of its own, it is handed one per call, so presence is
 * driven by use rather than by a timer (`touchPresence` throttles the write, and silence
 * lets the entry expire, which is the truthful answer once the host stops calling). Every
 * persona path enters through here, so this is the one place that can say it, the same
 * reason confinement itself lives here.
 */
function personaPath(p: string): string {
  const abs = confine(p);
  touchPresence(abs, { host: "mcp", project: confineRoot ?? process.cwd(), activity: "driven by an MCP host" });
  return abs;
}

/** Confine a path and bind an SDK Persona to it. */
function persona(p: string): Persona {
  return new Persona(personaPath(p));
}

export function compiledDocument(p: string): string {
  return persona(p).compiledBody();
}

export function stateSummary(p: string): unknown {
  const abs = personaPath(p);
  const h = loadPersona(abs);
  const st = ensureState(h);
  return {
    persona_id: st.persona_id,
    persona_version: st.persona_version,
    values: st.values,
    mutation_count: st.mutation_log.length,
    recent_mutations: st.mutation_log.slice(-5),
  };
}

export function envelopes(p: string): unknown {
  const abs = personaPath(p);
  const { envelopes, hardEnforcedVirtues } = extractEnvelopes(loadPersona(abs).frontmatter);
  return { mutable_fields: envelopes, hard_enforced_virtues: hardEnforcedVirtues };
}

export async function adjustState(
  p: string,
  field: string,
  delta: number,
  reason: string,
): Promise<unknown> {
  // Async because the move now lands in the hash-chained record before this returns.
  // The shape a host sees is unchanged except for `audit`, which used to be the row
  // pushed onto a log inside the state file and is now the whole printed state: the
  // file is a view of the record rather than a second copy of the history.
  const { decision, state } = await persona(p).adjust(field, delta, reason);
  return {
    field,
    from: decision.from,
    to: decision.to,
    clamped: decision.clamped,
    blocked: decision.blocked,
    audit: state.mutation_log.at(-1),
  };
}

export async function observe(p: string, observation: string, source: ProvenanceSource): Promise<unknown> {
  const { report, events } = await persona(p).observe(observation, source);
  return { report, events };
}

/**
 * Run the governed Agent Loop on a task. Non-interactive: any tool whose verdict
 * is `ask` is denied (the host can pre-authorize via the persona's permissions
 * allow-list). Requires a configured model for tool-calling.
 */
export async function agentRun(p: string, task: string, maxSteps = 12): Promise<unknown> {
  // The host asked, and the record says so. It is not the persona asking itself and it
  // is not a person: an MCP host drives a persona on somebody's behalf and this surface
  // never learns whose.
  return persona(p).agentRun(task, { maxSteps, asker: { kind: "component", name: "mcp" } });
}

export function audit(p: string): unknown {
  const a = persona(p).audit();
  return {
    memory_entries: a.memoryEntries,
    memory_chain_intact: a.memoryChainIntact,
    memory_chain_broken_at: a.memoryChainBrokenAt,
    anomalies: a.anomalies,
    mutation_count: a.mutationCount,
  };
}

/** Honor deletion_policy.user_request_supported: tombstone a memory entry. */
export function forget(p: string, targetHash: string, reason: string): unknown {
  const r = persona(p).forget(targetHash, reason);
  return { tombstoned: r.tombstoned, by: r.by, live_entries: r.liveEntries };
}

export function proposeEdit(p: string, targetPath: string, toValue: unknown, rationale: string): unknown {
  const r = persona(p).proposeEdit(targetPath, toValue, rationale);
  const { recompilePending, ...rest } = r as { recompilePending?: boolean };
  return { ...rest, recompile_pending: recompilePending };
}

export function listProposals(p: string): unknown {
  const { proposals, activeOverlay } = persona(p).listProposals();
  return { proposals, active_overlay: activeOverlay };
}

export function decideEdit(p: string, id: string, decision: "approve" | "reject"): unknown {
  const r = persona(p).decideEdit(id, decision, "mcp-host");
  const { recompilePending, ...rest } = r as { recompilePending?: boolean };
  return recompilePending === undefined ? rest : { ...rest, recompile_pending: recompilePending };
}

/**
 * Whether the persona's compiled PERSONA.md is stale (a self-edit was applied since the last
 * compile). MCP can't run an LLM, so the host calls `personaxis compile` when this is true.
 */
export function recompileStatus(p: string): unknown {
  const s = persona(p).recompileStatus();
  return { recompile_pending: s.recompilePending, reason: s.reason, since: s.since };
}

/** Security-review a skill before use (supply-chain defense). */
export function skillReview(skillPath: string): unknown {
  return sdkSkillReview(confine(skillPath));
}

/** Scan untrusted text for prompt-injection before it reaches the persona. */
export function scanText(text: string): unknown {
  return sdkScanText(text);
}

export function scanConfig(content: string, filename?: string): unknown {
  return sdkScanConfig(content, filename);
}

/**
 * Evaluate a shell command against a two-axis (approval × sandbox) policy. If a
 * persona path is given, the persona's OWN declared `permissions` posture is used
 * (v0.8); otherwise the explicit sandbox/approval args apply.
 */
export function evaluateCmd(
  command: string,
  sandbox: "read-only" | "workspace-write" | "danger-full-access",
  approval: "untrusted" | "on-failure" | "on-request" | "never",
  p?: string,
): unknown {
  return sdkEvaluateCmd(command, sandbox, approval, p ? personaPath(p) : undefined);
}
