/**
 * @personaxis/sdk, the SINGLE engine façade (F3.5).
 *
 * Embed a living, governed persona in a Node/TS backend (Mode 2 self-host). The
 * engine (@personaxis/core) does the governance, clamp + audit + injection scan
 * + hash-chained memory + the agent loop; this SDK is the ONE ergonomic surface
 * that drives it, with full parity across state, evolution, memory, agent, and
 * safety operations. The MCP server, `serve`, and the REPL consume this façade
 * rather than re-wrapping core (end of the wrapper triplication): host-specific
 * concerns (MCP path-confinement, HTTP shaping, REPL rendering) wrap the SDK,
 * they do not re-implement the engine.
 *
 * Example:
 *   import { Persona } from "@personaxis/sdk";
 *   const persona = new Persona("./.personaxis/personas/support/personaxis.md");
 *   const systemPrompt = persona.compiledIdentity();          // system-prompt slot #1
 *   await persona.observe("the customer is frustrated about billing", "user");
 *   const { values } = persona.state();
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
  readState,
  writeState,
  withStateLock,
  ensureState,
  extractEnvelopes,
  resolveField,
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
  type PersonaHandle,
  type LoopEvent,
  type ProvenanceSource,
} from "@personaxis/core";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface ObserveResult {
  report: { mutationsApplied: number; memoriesWritten: number; abstained: boolean };
  events: LoopEvent[];
  /** True if a governed self-edit left the compiled PERSONA.md stale (call `personaxis compile`). */
  recompilePending: boolean;
}

export interface PersonaStateView {
  values: Record<string, number>;
  recentMutations: unknown[];
}

export interface PersonaAuditView {
  mutationCount: number;
  memoryEntries: number;
  memoryChainIntact: boolean;
  memoryChainBrokenAt: number | null;
  anomalies: unknown[];
}

export interface AgentRunResult {
  result: unknown;
  events: LoopEvent[];
  trace: unknown[];
}

/** A live persona bound to its `personaxis.md` spec (its state.json + memory live alongside it). */
export class Persona {
  readonly personaPath: string;
  private handle: PersonaHandle;

  constructor(personaPath: string) {
    this.personaPath = resolve(personaPath);
    this.handle = loadPersona(this.personaPath);
    ensureState(this.handle);
  }

  private fm(): Record<string, unknown> {
    return this.handle.frontmatter as Record<string, unknown>;
  }

  /** The compiled, LLM-facing identity document (system-prompt slot #1). Falls back to the spec
   * body if PERSONA.md hasn't been compiled yet. */
  compiledIdentity(): string {
    const compiled = join(dirname(this.personaPath), "PERSONA.md");
    return existsSync(compiled) ? readFileSync(compiled, "utf-8") : this.handle.body;
  }

  /** The raw qualitative spec body (the compiled document as stored on the spec). */
  compiledBody(): string {
    return this.handle.body;
  }

  /** Current runtime state: envelope values + the last few audited mutations. */
  state(): PersonaStateView {
    const st = readState(this.handle.statePath);
    return { values: st.values, recentMutations: st.mutation_log.slice(-5) };
  }

  /** The mutable surface: envelope fields + the hard-enforced virtues that are immutable. */
  envelopes(): { mutableFields: Record<string, unknown>; hardEnforcedVirtues: unknown } {
    const { envelopes, hardEnforcedVirtues } = extractEnvelopes(this.handle.frontmatter);
    return { mutableFields: envelopes, hardEnforcedVirtues };
  }

  /**
   * Run ONE governed Living-Loop cycle on an observation, on the persona's resolved model
   * (falls back to the deterministic heuristic appraiser if no model is configured). Every mutation
   * is clamped + audited; a malicious observation is injection-scanned and cannot steer evolution.
   */
  async observe(observation: string, source: ProvenanceSource = "user"): Promise<ObserveResult> {
    const m = resolveModel({ personaPath: this.personaPath, frontmatter: this.fm() });
    const events: LoopEvent[] = [];
    const loop = new LivingLoop(this.personaPath, {
      appraiser: m ? new LlmAppraiser({ ...m, timeoutMs: 30_000 }) : new HeuristicAppraiser(),
    });
    loop.bus.on((e) => events.push(e));
    try {
      const report = await loop.tick({ observation, source });
      return { report, events, recompilePending: readRecompilePending(this.personaPath).pending };
    } catch (e) {
      return {
        report: { mutationsApplied: 0, memoriesWritten: 0, abstained: true },
        events: [...events, { type: "error", message: (e as Error).message }],
        recompilePending: readRecompilePending(this.personaPath).pending,
      };
    }
  }

  /** Apply a single clamped, audited mutation to an envelope field (the spec's adjust_persona_state). */
  adjust(field: string, delta: number, reason: string): ReturnType<typeof applyMutation> {
    const env = extractEnvelopes(this.handle.frontmatter);
    const resolved = resolveField(field, env.envelopes);
    // Locked read→apply→write: an embedding app may run ticks/adjusts concurrently (F1.4).
    return withStateLock(this.handle.statePath, () => {
      const st = readState(this.handle.statePath);
      const result = applyMutation(st, env.envelopes, { field: resolved, delta, reason, actor: "actor-llm" });
      writeState(this.handle.statePath, st);
      return result;
    });
  }

  /**
   * Run the governed Agent Loop on a task. Non-interactive: any tool whose verdict is `ask` is
   * denied unless the persona's permissions allow-list pre-authorizes it. Requires a configured model.
   */
  async agentRun(task: string, opts: { maxSteps?: number; onApproval?: () => Promise<"deny" | "approve"> } = {}): Promise<AgentRunResult | { error: string }> {
    const fm = this.fm();
    const llm = resolveModel({ personaPath: this.personaPath, frontmatter: fm });
    if (!llm) {
      return { error: "agent requires a configured model (config.json local.endpoint/model or PERSONAXIS_ENDPOINT + PERSONAXIS_MODEL)" };
    }
    const events: LoopEvent[] = [];
    const bus = new EventBus();
    bus.on((e) => events.push(e));
    const agent = new PersonaAgent({
      llm,
      policy: policyFromFrontmatter(fm, process.cwd()),
      personaBody: this.handle.body,
      onApproval: opts.onApproval ?? (async () => "deny"),
      maxSteps: opts.maxSteps ?? 12,
      budget: readAgentBudget(fm),
      verification: readVerification(fm),
      judge: llm,
      personaPath: this.personaPath,
      bus,
    });
    const obs = readObservability(fm);
    const tracer = obs.trace !== "off" ? new Tracer(bus, obs) : null;
    const result = await agent.run(task);
    const trace = tracer ? tracer.write(this.personaPath).paths : [];
    tracer?.stop();
    return { result, events, trace };
  }

  /** Integrity view: mutation count, memory size, hash-chain validity, detected anomalies. */
  audit(): PersonaAuditView {
    const st = readState(this.handle.statePath);
    const mem = readMemory(this.personaPath);
    const chain = verifyMemoryChain(this.personaPath);
    return {
      mutationCount: st.mutation_log.length,
      memoryEntries: mem.length,
      memoryChainIntact: chain.ok,
      memoryChainBrokenAt: chain.brokenAt ?? null,
      anomalies: detectMemoryAnomalies(mem),
    };
  }

  /** Honor deletion_policy.user_request_supported: tombstone a memory entry (retrieval removal). */
  forget(targetHash: string, reason: string): { tombstoned: string; by: string; liveEntries: number } {
    const entry = tombstoneMemory(this.personaPath, targetHash, reason);
    return { tombstoned: targetHash, by: entry.hash, liveEntries: readLiveMemory(this.personaPath).length };
  }

  /** Propose a governed self-edit (queued or applied per improvement_policy.mode). */
  proposeEdit(targetPath: string, toValue: unknown, rationale: string, sources: ProvenanceSource[] = ["user"]): Record<string, unknown> {
    const mode = readMode(this.fm(), this.personaPath);
    const result = proposeSelfEdit(this.personaPath, { targetPath, toValue, rationale, sources }, mode) as Record<string, unknown>;
    return { ...result, recompilePending: readRecompilePending(this.personaPath).pending };
  }

  /** Pending self-edit proposals + the active applied overlay. */
  listProposals(): { proposals: unknown; activeOverlay: unknown } {
    return { proposals: proposals(this.personaPath), activeOverlay: activeOverlay(this.personaPath) };
  }

  /**
   * Decide a pending proposal. `approver` MUST differ from the proposer (proposer≠approver);
   * hosts pass their own identity so the audit trail is meaningful.
   */
  decideEdit(id: string, decision: "approve" | "reject", approver: string): Record<string, unknown> {
    if (decision === "approve") {
      const applied = applySelfEdit(this.personaPath, id, approver) as Record<string, unknown>;
      return { ...applied, recompilePending: readRecompilePending(this.personaPath).pending };
    }
    rejectSelfEdit(this.personaPath, id, approver);
    return { id, status: "rejected" };
  }

  /** Whether the compiled PERSONA.md is stale (a governed self-edit was applied since the last compile). */
  recompileStatus(): { recompilePending: boolean; reason: string | null; since: string | null } {
    const s = readRecompilePending(this.personaPath);
    return { recompilePending: s.pending, reason: s.reason ?? null, since: s.ts ?? null };
  }

  /** Reload the spec from disk (e.g. after an external recompile/decompile). */
  reload(): void {
    this.handle = loadPersona(this.personaPath);
  }
}

// ── Persona-independent safety helpers (the same façade; no persona instance needed) ──────────────

/** Scan untrusted text for prompt-injection before it reaches a persona. */
export function scanText(text: string): ReturnType<typeof scanForInjection> {
  return scanForInjection(text);
}

/** Scan an agent config file's content for injection/poisoning (kind inferred from the filename). */
export function scanConfig(content: string, filename?: string): ReturnType<typeof scanAgentConfig> {
  return scanAgentConfig(content, filename ? detectKind(filename) : undefined);
}

/** Security-review a skill before use (supply-chain defense). */
export function skillReview(skillPath: string): ReturnType<typeof reviewSkill> {
  return reviewSkill(skillPath);
}

/**
 * Evaluate a shell command against a two-axis (approval × sandbox) policy. With a persona path, the
 * persona's OWN declared `permissions` posture is used (v0.8); otherwise the explicit args apply.
 */
export function evaluateCmd(
  command: string,
  sandbox: "read-only" | "workspace-write" | "danger-full-access",
  approval: "untrusted" | "on-failure" | "on-request" | "never",
  personaPath?: string,
): ReturnType<typeof evaluateCommand> {
  const policy = personaPath
    ? policyFromFrontmatter(loadPersona(resolve(personaPath)).frontmatter, process.cwd())
    : { ...DEFAULT_POLICY, sandbox, approval, workspaceRoot: process.cwd() };
  return evaluateCommand(command, policy);
}

export { resolveModel } from "@personaxis/core";
