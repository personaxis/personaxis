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
  PersonaAgent,
  EventBus,
  Tracer,
  readObservability,
  loadPersona,
  writeState,
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
  reviewSkill,
  scanForInjection,
  evaluateCommand,
  policyFromFrontmatter,
  readAgentBudget,
  readVerification,
  DEFAULT_POLICY,
  type LoopEvent,
  type ProvenanceSource,
} from "@personaxis/core";

export function compiledDocument(persona: string): string {
  return loadPersona(persona).body;
}

export function stateSummary(persona: string): unknown {
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
  const h = loadPersona(persona);
  const env = extractEnvelopes(h.frontmatter);
  const state = ensureState(h);
  const result = applyMutation(state, env.envelopes, {
    field,
    delta,
    reason,
    actor: "actor-llm",
  });
  writeState(h.statePath, state);
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
  const events: LoopEvent[] = [];
  ensureState(loadPersona(persona)); // seed state.json if missing
  const loop = new LivingLoop(persona, { appraiser: new HeuristicAppraiser() });
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
 * allow-list). Requires PERSONAXIS_ENDPOINT + PERSONAXIS_MODEL for tool-calling.
 */
export async function agentRun(persona: string, task: string, maxSteps = 12): Promise<unknown> {
  const endpoint = process.env.PERSONAXIS_ENDPOINT;
  const model = process.env.PERSONAXIS_MODEL;
  if (!endpoint || !model) {
    return { error: "agent requires PERSONAXIS_ENDPOINT + PERSONAXIS_MODEL (tool-calling model)" };
  }
  const handle = loadPersona(persona);
  ensureState(handle);
  const events: LoopEvent[] = [];
  const bus = new EventBus();
  bus.on((e) => events.push(e));
  const fm = handle.frontmatter as Record<string, unknown>;
  const agent = new PersonaAgent({
    llm: { endpoint, model, apiKey: process.env.PERSONAXIS_API_KEY },
    policy: policyFromFrontmatter(fm, process.cwd()),
    personaBody: handle.body,
    onApproval: async () => "deny", // non-interactive host: deny anything needing approval
    maxSteps,
    budget: readAgentBudget(fm),
    verification: readVerification(fm),
    judge: { endpoint, model, apiKey: process.env.PERSONAXIS_API_KEY },
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
  const entry = tombstoneMemory(persona, targetHash, reason);
  return { tombstoned: targetHash, by: entry.hash, live_entries: readLiveMemory(persona).length };
}

export function proposeEdit(
  persona: string,
  targetPath: string,
  toValue: unknown,
  rationale: string,
): unknown {
  const h = loadPersona(persona);
  const mode = readMode(h.frontmatter as Record<string, unknown>);
  return proposeSelfEdit(persona, { targetPath, toValue, rationale, sources: ["user"] }, mode);
}

export function listProposals(persona: string): unknown {
  return { proposals: proposals(persona), active_overlay: activeOverlay(persona) };
}

export function decideEdit(persona: string, id: string, decision: "approve" | "reject"): unknown {
  if (decision === "approve") return applySelfEdit(persona, id, "mcp-host");
  rejectSelfEdit(persona, id, "mcp-host");
  return { id, status: "rejected" };
}

/** Security-review a skill before use (supply-chain defense). */
export function skillReview(skillPath: string): unknown {
  return reviewSkill(skillPath);
}

/** Scan untrusted text for prompt-injection before it reaches the persona. */
export function scanText(text: string): unknown {
  return scanForInjection(text);
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
    ? policyFromFrontmatter(loadPersona(persona).frontmatter, process.cwd())
    : { ...DEFAULT_POLICY, sandbox, approval, workspaceRoot: process.cwd() };
  return evaluateCommand(command, policy);
}
