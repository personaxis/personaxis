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
  run,
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
  personaResourceRoots,
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

  private assembled: run.AssembledPersona;

  constructor(personaPath: string) {
    this.assembled = run.assemble(personaPath);
    this.personaPath = this.assembled.personaPath;
    this.handle = this.assembled.handle;
  }

  private fm(): Record<string, unknown> {
    return this.handle.frontmatter as Record<string, unknown>;
  }

  /**
   * The compiled, LLM-facing identity document (system-prompt slot #1). Falls back to
   * the spec body if PERSONA.md has not been compiled yet.
   *
   * This looked for `PERSONA.md` beside `personaxis.md` and a ROOT persona's compiled
   * document lives one level above, beside the `.personaxis/` folder. So for the most
   * common layout there is, the file was never found, the fallback fired, and this
   * returned the raw spec body under a name promising otherwise. Measured on the
   * repository this was found in: 2,640 characters where the compiled document is
   * 6,283, with no error and no warning.
   *
   * The address now has one owner, in core, which is where the REPL's correct version
   * moved to so that this could stop having its own.
   */
  compiledIdentity(): string {
    return run.identityOf(this.assembled);
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
    const events: LoopEvent[] = [];
    const evolver = run.evolverFor(
      { personaPath: this.personaPath, frontmatter: this.fm() },
      {
        // No inline recompile, and this is now written rather than omitted. A band
        // crossing still marks the compiled document stale, which is what
        // `recompilePending` below reports; what an embedded library does not do is
        // spend the host application's model budget on a rewrite nobody asked for.
        // The REPL, where a person is waiting and would otherwise be talking to a
        // document that no longer matches the state, does the opposite.
        recompile: null,
        onEvent: (e: LoopEvent) => events.push(e),
      },
    );
    try {
      const report = await evolver.observe({ observation, source });
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
      policy: { ...policyFromFrontmatter(fm, process.cwd()), resourceRoots: personaResourceRoots(this.personaPath) },
      // The compiled identity, not the raw spec body, which is what this passed and
      // is the same defect `compiledIdentity()` had one method above. `personaBody`
      // becomes the "# Identity" section of the system prompt, so a persona run
      // through this SDK was given a thinner description of itself than the same
      // persona in the REPL, which passes its compiled document. Measured here:
      // 2,640 characters against 6,283.
      personaBody: run.identityOf(this.assembled),
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
    this.assembled = run.assemble(this.personaPath);
    this.handle = this.assembled.handle;
  }
}

// ── Persona-independent safety helpers (the same façade; no persona instance needed) ──────────────

/** Scan untrusted text for prompt-injection before it reaches a persona. */
export function scanText(text: string): ReturnType<typeof scanForInjection> {
  return scanForInjection(text);
}

/** The decision returned by {@link guardInput}. */
export interface GuardDecision {
  /** false when the input should NOT reach your agent. */
  allowed: boolean;
  verdict: "clean" | "suspicious" | "malicious";
  /** Set when `allowed` is false. */
  reason?: string;
  scan: ReturnType<typeof scanForInjection>;
}

export interface GuardOptions {
  /** Block at this verdict or worse. Default "malicious". */
  blockAt?: "suspicious" | "malicious";
}

/**
 * Mode 1 wedge ("bring your own agent"): guard an incoming message before it
 * reaches your existing agent. Scans for prompt-injection / jailbreak and
 * decides whether to let it through, so an adversarial input cannot steer the
 * agent out of its persona. Governs the input; your agent still does its task.
 */
export function guardInput(text: string, opts: GuardOptions = {}): GuardDecision {
  const blockAt = opts.blockAt ?? "malicious";
  const scan = scanForInjection(text);
  const order = { clean: 0, suspicious: 1, malicious: 2 } as const;
  const allowed = order[scan.verdict] < order[blockAt];
  return {
    allowed,
    verdict: scan.verdict,
    reason: allowed ? undefined : `input blocked: ${scan.verdict} (score ${scan.score.toFixed(2)})`,
    scan,
  };
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
    ? { ...policyFromFrontmatter(loadPersona(resolve(personaPath)).frontmatter, process.cwd()), resourceRoots: personaResourceRoots(resolve(personaPath)) }
    : { ...DEFAULT_POLICY, sandbox, approval, workspaceRoot: process.cwd() };
  return evaluateCommand(command, policy);
}

export { resolveModel } from "@personaxis/core";
