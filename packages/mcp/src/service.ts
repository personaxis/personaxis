/**
 * Persona service — the engine operations the MCP tools wrap.
 *
 * Each function takes an explicit persona path so a host can drive multiple
 * personas. All mutation goes through the same clamp + audit engine the CLI and
 * runtime use; nothing here bypasses the governance gate or the universal
 * invariants.
 */

import {
  LivingLoop,
  HeuristicAppraiser,
  LlmAppraiser,
  resolveModel,
  PersonaAgent,
  EventBus,
  Tracer,
  readObservability,
  loadPersona,
  writeState,
  readState,
  withStateLock,
  ensureState,
  extractEnvelopes,
  applyMutation,
  readMemory,
  readLiveMemory,
  tombstoneMemory,
  verifyMemoryChain,
  detectMemoryAnomalies,
  readMode,
  proposeSelfEdit,
  applySelfEdit,
  rejectSelfEdit,
  proposals,
  activeOverlay,
  readRecompilePending,
  reviewSkill,
  scanForInjection,
  scanAgentConfig,
  detectKind,
  evaluateCommand,
  policyFromFrontmatter,
  readAgentBudget,
  readVerification,
  DEFAULT_POLICY,
  type LoopEvent,
  type ProvenanceSource,
} from "@personaxis/core";
import { resolve as presolve, relative, isAbsolute } from "node:path";

// ── Path confinement (ADR-011: --root) ──────────────────────────────────────
// When a root is set (the stdio server ALWAYS sets one — the --root flag or its
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

export function compiledDocument(persona: string): string {
  persona = confine(persona);
  return loadPersona(persona).body;
}

export function stateSummary(persona: string): unknown {
  persona = confine(persona);
  const h = loadPersona(persona);
  const st = ensureState(h);
  return {
    persona_id: st.persona_id,
    persona_version: st.persona_version,
    values: st.values,
    mutation_count: st.mutation_log.length,
    recent_mutations: st.mutation_log.slice(-5),
  };
}

export function envelopes(persona: string): unknown {
  persona = confine(persona);
  const h = loadPersona(persona);
  const { envelopes, hardEnforcedVirtues } = extractEnvelopes(h.frontmatter);
  return { mutable_fields: envelopes, hard_enforced_virtues: hardEnforcedVirtues };
}

export function adjustState(
  persona: string,
  field: string,
  delta: number,
  reason: string,
): unknown {
  persona = confine(persona);
  const h = loadPersona(persona);
  const env = extractEnvelopes(h.frontmatter);
  ensureState(h);
  // Locked read→apply→write: a concurrent tick/serve must not lose this mutation (F1.4).
  const result = withStateLock(h.statePath, () => {
    const state = readState(h.statePath);
    const r = applyMutation(state, env.envelopes, {
      field,
      delta,
      reason,
      actor: "actor-llm",
    });
    writeState(h.statePath, state);
    return r;
  });
  return {
    field,
    from: result.from,
    to: result.to,
    clamped: result.clamped,
    blocked: result.blocked,
    audit: result.entry,
  };
}

export async function observe(
  persona: string,
  observation: string,
  source: ProvenanceSource,
): Promise<unknown> {
  persona = confine(persona);
  const events: LoopEvent[] = [];
  const handle = loadPersona(persona);
  ensureState(handle); // seed state.json if missing
  // Use the persona's resolved model (config/env) for a real appraisal; fall back to heuristic.
  const m = resolveModel({ personaPath: persona, frontmatter: handle.frontmatter as Record<string, unknown> });
  const loop = new LivingLoop(persona, { appraiser: m ? new LlmAppraiser({ ...m, timeoutMs: 30_000 }) : new HeuristicAppraiser() });
  loop.bus.on((e) => events.push(e));
  // Best-effort: a tick failure must not crash the MCP server (mirror the REPL).
  try {
    const report = await loop.tick({ observation, source });
    return { report, events };
  } catch (e) {
    return {
      report: { mutationsApplied: 0, memoriesWritten: 0, abstained: true },
      events: [...events, { type: "error", message: (e as Error).message }],
    };
  }
}

/**
 * Run the governed Agent Loop on a task. Non-interactive: any tool whose verdict
 * is `ask` is denied (the host can pre-authorize via the persona's permissions
 * allow-list). Requires a configured model (config.json local.endpoint/model, or
 * PERSONAXIS_ENDPOINT + PERSONAXIS_MODEL) for tool-calling.
 */
export async function agentRun(persona: string, task: string, maxSteps = 12): Promise<unknown> {
  persona = confine(persona);
  const handle = loadPersona(persona);
  const fm = handle.frontmatter as Record<string, unknown>;
  const llm = resolveModel({ personaPath: persona, frontmatter: fm });
  if (!llm) {
    return { error: "agent requires a configured model (config.json local.endpoint/model or PERSONAXIS_ENDPOINT + PERSONAXIS_MODEL)" };
  }
  ensureState(handle);
  const events: LoopEvent[] = [];
  const bus = new EventBus();
  bus.on((e) => events.push(e));
  const agent = new PersonaAgent({
    llm,
    policy: policyFromFrontmatter(fm, process.cwd()),
    personaBody: handle.body,
    onApproval: async () => "deny", // non-interactive host: deny anything needing approval
    maxSteps,
    budget: readAgentBudget(fm),
    verification: readVerification(fm),
    judge: llm,
    personaPath: persona,
    bus,
  });
  const obs = readObservability(fm);
  const tracer = obs.trace !== "off" ? new Tracer(bus, obs) : null;
  const result = await agent.run(task);
  const trace = tracer ? tracer.write(persona).paths : [];
  tracer?.stop();
  return { result, events, trace };
}

export function audit(persona: string): unknown {
  persona = confine(persona);
  const h = loadPersona(persona);
  const st = ensureState(h);
  const chain = verifyMemoryChain(persona);
  const mem = readMemory(persona);
  return {
    mutation_log: st.mutation_log.slice(-10),
    memory_entries: mem.length,
    memory_chain_intact: chain.ok,
    memory_chain_broken_at: chain.brokenAt ?? null,
    anomalies: detectMemoryAnomalies(mem),
  };
}

/** Honor deletion_policy.user_request_supported: tombstone a memory entry. */
export function forget(persona: string, targetHash: string, reason: string): unknown {
  persona = confine(persona);
  const entry = tombstoneMemory(persona, targetHash, reason);
  return { tombstoned: targetHash, by: entry.hash, live_entries: readLiveMemory(persona).length };
}

export function proposeEdit(
  persona: string,
  targetPath: string,
  toValue: unknown,
  rationale: string,
): unknown {
  persona = confine(persona);
  const h = loadPersona(persona);
  const mode = readMode(h.frontmatter as Record<string, unknown>);
  const result = proposeSelfEdit(persona, { targetPath, toValue, rationale, sources: ["user"] }, mode);
  // Surface staleness so the HOST (which holds the LLM) knows to recompile PERSONA.md.
  return { ...result, recompile_pending: readRecompilePending(persona).pending };
}

export function listProposals(persona: string): unknown {
  persona = confine(persona);
  return { proposals: proposals(persona), active_overlay: activeOverlay(persona) };
}

export function decideEdit(persona: string, id: string, decision: "approve" | "reject"): unknown {
  persona = confine(persona);
  if (decision === "approve") {
    const applied = applySelfEdit(persona, id, "mcp-host") as Record<string, unknown>;
    return { ...applied, recompile_pending: readRecompilePending(persona).pending };
  }
  rejectSelfEdit(persona, id, "mcp-host");
  return { id, status: "rejected" };
}

/**
 * Whether the persona's compiled PERSONA.md is stale (a self-edit was applied since the last
 * compile). MCP can't run an LLM, so the host calls `personaxis compile` when this is true.
 */
export function recompileStatus(persona: string): unknown {
  persona = confine(persona);
  const s = readRecompilePending(persona);
  return { recompile_pending: s.pending, reason: s.reason ?? null, since: s.ts ?? null };
}

/** Security-review a skill before use (supply-chain defense). */
export function skillReview(skillPath: string): unknown {
  skillPath = confine(skillPath);
  return reviewSkill(skillPath);
}

/** Scan untrusted text for prompt-injection before it reaches the persona. */
export function scanText(text: string): unknown {
  return scanForInjection(text);
}

export function scanConfig(content: string, filename?: string): unknown {
  return scanAgentConfig(content, filename ? detectKind(filename) : undefined);
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
  persona?: string,
): unknown {
  const policy = persona
    ? policyFromFrontmatter(loadPersona(confine(persona)).frontmatter, process.cwd())
    : { ...DEFAULT_POLICY, sandbox, approval, workspaceRoot: process.cwd() };
  return evaluateCommand(command, policy);
}
