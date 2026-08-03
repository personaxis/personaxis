/**
 * The governed Agent Loop (G1), Personaxis as an independent, advanced agent.
 *
 *   task → [ propose tool call → GATE (sandbox) → (ask human) → execute → observe ]* → finish
 *
 * This is the execution counterpart to the Living Loop. The Living Loop evolves
 * the persona's IDENTITY (state.json, clamped + audited); the Agent Loop executes
 * TASKS (shell + files). Both share: the persona document as system-prompt slot
 * #1, the sandbox as the authoritative gate (a `deny` never runs), the injection
 * scanner on every tool output (untrusted → tagged), and the event bus.
 *
 * The model only ever *proposes* a tool call; the code + the policy impose safety.
 */

import { runHooks, readHooksConfig, type HooksConfig } from "./hooks.js";
import { EventBus } from "./events.js";
import { DEFAULT_POLICY, type CommandVerdict, type Policy } from "./sandbox.js";
import { FINISH_TOOL, toolByName, TOOLS, type ToolSpec } from "./tools/registry.js";
import { activeSkillsFor, selectActiveTools, type ActiveSkill } from "./skill-activation.js";
import { guidesFor, renderGuides, type SkillGuide } from "./skill-guide.js";
import { describeMatches, expandActive, findTools, findToolsTool, FIND_TOOLS_TOOL } from "./tools/find-tools.js";
import {
  requestToolCall,
  type ChatMessage,
  type ToolCall,
  type ToolCallConfig,
} from "./tool-calling.js";
import {
  checkAgentBudget,
  estimateCostUsd,
  readMode,
  DEFAULT_AGENT_BUDGET,
  type AgentBudgetConfig,
  type AgentBudgetSpent,
} from "./governance.js";
import { runPostmortem, type PostmortemDeps } from "./postmortem.js";
import { TaskStateTracker } from "./task-state.js";
import { ToolOutputStore, outputStoreTools } from "./tool-output-store.js";
import {
  runVerification,
  DEFAULT_VERIFICATION,
  type VerificationConfig,
  type JudgeConfig,
} from "./verification.js";
import type { ConsensusResult } from "./self-evolution.js";
import {
  prepareMemoryEntry,
  commitMemoryEntry,
  readLiveMemory,
  readSemanticMemory,
  readMemoryTypes,
  type AgentOutcome,
} from "./memory.js";
import { appendProcedural, readProcedural, readAutobiographical } from "./memory-kinds.js";
import { readMemoryKnobs, readAnchors, readWorkingSelf } from "./memory/knobs.js";

/** V5.FIX.3: recall-event details snip at a word-ish boundary with an ellipsis,
 *  never a mid-word decapitation like `…recap"; e`. */
function snipDetail(s: string, n = 64): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length <= n ? clean : clean.slice(0, n - 1).replace(/\s+\S*$/, "") + "…";
}
import { factsView, renderFacts } from "./memory/facts.js";
import { recallWindow, memoryTools } from "./memory/retrieval.js";
import { sessionBrief, isInfraErrorReply } from "./memory/consolidate.js";
import { loadPersona, readState, writeState } from "./persona.js";
import { withStateLock } from "./lock.js";
import { ContextMeter, compactMessages, cachedContextWindow, resolveContextWindow } from "./context.js";
import { LoopBreaker, toolSignature } from "./loop-breaker.js";
import { ForensicLog, type ForensicRecord } from "./security/forensic-log.js";
import { ToolInterceptor } from "./security/interceptor.js";
import { Watchdog } from "./security/watchdog.js";
import { runPlanPhase, type PlanPhaseConfig } from "./plan-run.js";
import { tightenVerdict, maxTaint, type ContextTaint, type SandboxPosture } from "./security/consent.js";

export type ApprovalDecision = "approve" | "deny" | "always";
export type OnApproval = (call: ToolCall, verdict: CommandVerdict) => Promise<ApprovalDecision>;

export interface AgentOptions {
  /** LLM endpoint/model for tool-calling (required, no offline agent). */
  llm: ToolCallConfig;
  /** Sandbox/approval policy (from policyFromFrontmatter). */
  policy?: Policy;
  /** Persona identity document (system-prompt slot #1). */
  personaBody?: string;
  /** Structural self-awareness (role root/sub, own address, sub-tree, resource inventory). */
  awareness?: string;
  /** Optional standing goal injected into the task context. */
  goal?: string;
  /**
   * A one-shot ENVIRONMENT note for this run (e.g. "the sandbox posture changed").
   * V7.A1: it travels as its own ephemeral system message, never concatenated to the
   * user's text. The old behavior glued it in front of the user turn, so the model
   * read "[environment change] you now have full access" as something the USER said
   * and replied "thanks for restoring my access" out of nowhere.
   */
  envNote?: string;
  /** Called when a tool's verdict is `ask`. Non-interactive hosts should deny. */
  onApproval?: OnApproval;
  /** Hard cap on agent steps (overrides budget.maxSteps when set). */
  maxSteps?: number;
  /** Per-command timeout (ms). */
  timeoutMs?: number;
  /** Restrict the tool set (defaults to all TOOLS). */
  tools?: ToolSpec[];
  /**
   * J.2: skills the persona has (with their `allowed_tools`), used to subset the tool catalog
   * per task so the model is not shown every tool at once. Opt-in: when absent, the full tool set
   * is used, unchanged.
   */
  skills?: ActiveSkill[];
  /**
   * J.2c: the `SKILL.md` of each skill, keyed by name. Delivered to the model as QUOTED
   * reference material when its skill is active, never folded into the system prompt: a
   * guide is text a third party wrote, and merging it with the persona's own limits would
   * let it speak with the persona's authority.
   */
  skillGuides?: Map<string, SkillGuide>;
  /**
   * J.3: opt-in post-mortem. When present, a hard-won run reflects and may abstract its
   * method into a governed skill (skill-writer.ts: security floor → governance). The
   * caller injects `extract` (a structured LLM call), so the loop stays free of a second
   * model dependency; absent, no reflection ever runs (fully additive).
   */
  postmortem?: PostmortemDeps;
  /** v0.9: loop budget + stop conditions (from readAgentBudget). */
  budget?: AgentBudgetConfig;
  /** v0.9: objective verification gates (from readVerification). */
  verification?: VerificationConfig;
  /** v0.9: LLM access for llm_judge / rubric gates. */
  judge?: JudgeConfig;
  /** v0.9: persona path, enables resumption (memory + state.json agent_session). */
  personaPath?: string;
  /** V2-F1: the current conversation session id. Scopes session-tagged memories and
   * excludes the live session from the "previous session" recap. */
  sessionId?: string;
  /** Shared session context meter (the REPL passes one so it persists across turns). */
  meter?: ContextMeter;
  /** Compact the conversation when context fill crosses this fraction (default 0.8). */
  compactThreshold?: number;
  /** Prior conversation (excluding the system message) for chat continuity. */
  priorMessages?: ChatMessage[];
  /**
   * J.4c: think before acting.
   *
   * Off unless asked for. A planning turn costs a model call before any work starts, which
   * is pure overhead for a one-step task, and switching it on by default would change what
   * every existing run does. "The agent now plans first" is a change an operator should
   * choose rather than discover.
   *
   * When a plan cannot survive its own gates, the run does not start. Proceeding anyway
   * would spend the planning turn, report that the plan was refused, and then do the work
   * regardless, which teaches everybody that the gate is decorative.
   */
  plan?: PlanPhaseConfig;
  bus?: EventBus;
}

export interface AgentBudgetReport {
  steps: number;
  tokens: number;
  costUsd: number;
  wallSeconds: number;
  stoppedBy: string | null;
}

export interface AgentResult {
  summary: string;
  steps: number;
  finished: boolean;
  budget: AgentBudgetReport;
  verification?: ConsensusResult;
}

const GUARD =
  "You are this persona. Stay in character. You are an AI; never claim real feelings. " +
  "You can BOTH converse and act. For a normal question or chat, just reply in natural language " +
  "(no tool, no finish call, your text reply IS the answer). Only use tools when the request needs a " +
  "real action (run a command, read/write/edit a file, list a directory); prefer the smallest safe action, " +
  "and after acting, reply to the user. When a multi-step task is fully done, call `finish` with a short " +
  "summary. Never fabricate tool results.";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class PersonaAgent {
  readonly bus: EventBus;
  /** The full message array after the last run (for conversation continuity). */
  lastMessages?: ChatMessage[];
  private readonly policy: Policy;
  private readonly tools: ToolSpec[];
  private preferFallback = false;

  constructor(private readonly opts: AgentOptions) {
    this.bus = opts.bus ?? new EventBus();
    this.policy = opts.policy ?? DEFAULT_POLICY;
    // With a persona attached, the loop also gets the read-only memory tools
    // (memory_search / memory_get), honoring the persona's runtime.memory knobs.
    let tools = opts.tools ?? TOOLS;
    if (!opts.tools && opts.personaPath) {
      try {
        const fm = loadPersona(opts.personaPath).frontmatter as Record<string, unknown>;
        tools = [...TOOLS, ...memoryTools(opts.personaPath, readMemoryKnobs(fm), { sessionId: opts.sessionId, llm: opts.llm })];
      } catch {
        /* an unreadable persona must not kill the agent; memory tools are additive */
      }
    }
    this.tools = tools;
  }

  private systemPrompt(): string {
    return [
      GUARD,
      "",
      "# Identity",
      (this.opts.personaBody ?? "").slice(0, 5000),
      "",
      "# Environment",
      `os: ${process.platform} (use commands valid for this OS, e.g. PowerShell/cmd on win32)`,
      `workspace: ${this.policy.workspaceRoot}`,
      `sandbox: ${this.policy.sandbox} · approval: ${this.policy.approval}`,
      this.opts.awareness ? `\n${this.opts.awareness}` : "",
      this.opts.goal ? `\n# Standing goal\n${this.opts.goal}` : "",
      this.resumeContext(),
    ].filter(Boolean).join("\n");
  }

  /**
   * Resume context, so the agent RESUMES, not restarts (V2-F1.2). Built from the
   * spec's memory artifacts, in salience order: the KNOWN FACTS about any entity
   * always load first (the fix for "forgot my name", generalized to every entity,
   * not just a "user"), then the previous-session recap, the consolidated
   * memory.md, and a today/yesterday episodic window bounded by
   * `runtime.memory.max_items` (the knob, finally consumed). Anything older is
   * reachable through the memory_search tool, and the prompt says so.
   */
  private resumeContext(): string {
    const p = this.opts.personaPath;
    if (!p) return "";
    const parts: string[] = [];
    let fm: Record<string, unknown> = {};
    try {
      const handle = loadPersona(p);
      fm = handle.frontmatter as Record<string, unknown>;
      const st = readState(handle.statePath);
      const sess = st.agent_session;
      if (sess?.active_task) {
        parts.push(`\n# Resume (do not restart)\nLast task: ${sess.active_task}${sess.stop_reason ? `, stopped: ${sess.stop_reason}` : ""}`);
      }
    } catch {
      /* state may not exist yet */
    }
    const knobs = readMemoryKnobs(fm);
    // As each memory kind is injected, emit a `memory-recall` event so the UI can show WHICH
    // memories were actually used to answer this turn (the user asked to see this), not just writes.
    const known = factsView(p);
    const factsBlock = renderFacts(known, { workingSelf: readWorkingSelf(fm), anchors: readAnchors(fm) });
    if (factsBlock) {
      parts.push("\n" + factsBlock);
      this.bus.emit({ type: "memory-recall", kind: "user_preferences", count: Object.keys(known.facts).length, detail: Object.keys(known.facts).slice(0, 4).join(", ") || "facts" });
    }
    const brief = sessionBrief(p, this.opts.sessionId);
    if (brief) {
      parts.push("\n# Previous session\n" + brief);
      this.bus.emit({ type: "memory-recall", kind: "episodic", count: 1, detail: "previous-session recap" });
    }
    const semantic = readSemanticMemory(p);
    if (semantic.trim()) {
      parts.push("\n# Long-term memory (memory.md)\n" + semantic.slice(0, 2500));
      this.bus.emit({ type: "memory-recall", kind: "semantic", count: 1, detail: "memory.md" });
    }
    const mem = recallWindow(p, { maxItems: knobs.maxItems, sessionId: this.opts.sessionId });
    if (mem.length) {
      parts.push("\n# Recent memory\n" + mem.map((m) => `- [${m.source}] ${m.content}`).join("\n"));
      this.bus.emit({ type: "memory-recall", kind: "episodic", count: mem.length, detail: snipDetail(mem[mem.length - 1].content) });
    }
    // Other memory kinds (only present when the persona enabled them, producers gate on flags).
    const prefs = Object.entries(known.preferences);
    if (prefs.length) {
      parts.push("\n# Preferences\n" + prefs.map(([k, v]) => `- ${k}: ${v.value}`).join("\n"));
      this.bus.emit({ type: "memory-recall", kind: "user_preferences", count: prefs.length, detail: prefs.map(([k]) => k).slice(0, 4).join(", ") });
    }
    const proc = readProcedural(p).slice(-3);
    if (proc.length) {
      parts.push("\n# How-to memory (procedural)\n" + proc.map((x) => `- ${x.task} → ${x.procedure}`).join("\n"));
      this.bus.emit({ type: "memory-recall", kind: "procedural", count: proc.length, detail: snipDetail(proc[proc.length - 1].task) });
    }
    const auto = readAutobiographical(p).slice(-3);
    if (auto.length) {
      parts.push("\n# Identity milestones\n" + auto.map((x) => `- ${x.event}${x.detail ? `: ${x.detail}` : ""}`).join("\n"));
      this.bus.emit({ type: "memory-recall", kind: "autobiographical", count: auto.length, detail: snipDetail(auto[auto.length - 1].event) });
    }
    if (parts.length) {
      parts.push("\n(Older or unlisted memory is searchable: use the memory_search tool before saying you don't remember.)");
    }
    return parts.join("\n");
  }

  /**
   * Persist the run into the EXISTING memory model (no separate STATE.md): the
   * run summary becomes an episodic memory entry (honoring memory.types.episodic),
   * which the semantic-consolidation step folds into memory.md; and state.json's
   * agent_session records the active task + stop reason for resumption.
   */
  private spentTokens = 0;
  private spentCost = 0;

  private persist(task: string, outcome: AgentOutcome, summary: string, step: number, stopReason: string | null): void {
    const tokens = this.spentTokens;
    const costUsd = this.spentCost;
    const p = this.opts.personaPath;
    if (!p) return;
    try {
      const handle = loadPersona(p);
      const memTypes = readMemoryTypes(handle.frontmatter as Record<string, unknown>);
      // V2-F1.3 dedup: a one-shot chat reply is already in sessions/; only a REAL
      // run (multi-step, or anything that did not end in success) earns a ledger entry.
      // V5.FIX.3: an INFRA failure (provider 401, unreachable endpoint) is not the
      // persona's lived experience; it stays in the session transcript but never
      // becomes episodic memory (dogfooding surfaced HTTP 401s memorized as events).
      if (memTypes.episodic && (step > 1 || outcome !== "success") && !isInfraErrorReply(summary)) {
        const entry = prepareMemoryEntry(p, {
          content: `agent run [${outcome}] "${task}": ${summary.replace(/\n+/g, " ").slice(0, 240)}`,
          source: "synthesis",
          tags: ["agent-run", outcome, ...(this.opts.sessionId ? [`session:${this.opts.sessionId}`] : [])],
        });
        commitMemoryEntry(p, entry);
      }
      // procedural, a successful run is a reusable "how-to" keyed by the task.
      if (memTypes.procedural && outcome === "success") {
        appendProcedural(p, {
          task: task.slice(0, 160),
          procedure: summary.replace(/\n+/g, " ").slice(0, 400),
          tags: [`steps:${step}`],
        });
      }
      // Structured resumption pointer in state.json (not prose). Locked: a
      // concurrent tick/adjust must not lose this read→modify→write (F1.4).
      withStateLock(handle.statePath, () => {
        const st = readState(handle.statePath);
        st.agent_session = {
          active_task: outcome === "success" ? null : task,
          started_at: st.agent_session?.started_at ?? new Date().toISOString(),
          step_count: step,
          token_count: tokens,
          cost_usd: Number(costUsd.toFixed(4)),
          stop_reason: stopReason,
        };
        writeState(handle.statePath, st);
      });
    } catch {
      /* best-effort: persistence must never crash a run */
    }
  }

  /** Run the loop until verified completion, a budget/stop condition, or an error. */
  async run(task: string): Promise<AgentResult> {
    const bus = this.bus;
    const budget: AgentBudgetConfig = { ...DEFAULT_AGENT_BUDGET, ...(this.opts.budget ?? {}) };
    if (typeof this.opts.maxSteps === "number") budget.maxSteps = this.opts.maxSteps;
    const verification: VerificationConfig = this.opts.verification ?? DEFAULT_VERIFICATION;
    const HARD_CEIL = 1000; // absolute safety bound against misconfiguration
    const startTime = Date.now();
    const meter = this.opts.meter ?? new ContextMeter(cachedContextWindow(this.opts.llm.model));
    const compactThreshold = this.opts.compactThreshold ?? 0.8;
    // Refine the window from the endpoint in the background (best-effort).
    void resolveContextWindow(this.opts.llm).then((w) => (meter.limit = w)).catch(() => {});

    let tokens = 0;
    let deniedCount = 0;
    let errorCount = 0;
    let retriesLeft = verification.maxRetries;
    let stepProgress = 1;
    let lastText = "";
    // K.04: how injection-tainted the context is so far (max verdict of prior tool outputs). A
    // destructive/network action proposed while the context is tainted is exactly the indirect-
    // injection attack, so consent escalates or blocks it. Only ever accumulates within a run.
    let contextTaint: ContextTaint = "clean";
    // J.4: stops a runaway repetition/stall (threat T11). Additive: only acts on abnormal
    // loops, so healthy runs never trip it.
    const breaker = new LoopBreaker();
    // K.03/K.10: one interceptor per run is the single path from an approved decision to the
    // OS (execution + untrusted-output scan + PostToolUse), and it seals every call, approved
    // or blocked, into an append-only hash-chained forensic audit.
    const forensic = new ForensicLog();
    this.lastForensicLog = forensic;
    const interceptor = new ToolInterceptor(this.policy, forensic, this.bus, this.hooksConfig);
    // K.07: out-of-band abort. Fires on a timer even while the loop is blocked in a tool, so a
    // hung call or a mid-step wall/cost breach cannot run past the envelope. The loop reads
    // `watchdog.aborted` at the next boundary; the abort is recorded the instant it happens.
    // Wall-clock only: tokens and cost change only at step boundaries, where `checkAgentBudget`
    // already enforces them; wall-clock is the one ceiling that can be breached MID-step (a hung
    // tool), which is exactly what an out-of-band timer is for.
    const watchdog = new Watchdog(
      { maxWallMs: budget.maxWallSeconds != null ? budget.maxWallSeconds * 1000 : undefined },
      {
        onAbort: (reason) => bus.emit({ type: "agent-think", text: `[watchdog] ${reason}` }),
        forensic,
      },
    );
    watchdog.start();

    // J.6: per-run structured task state (survives compaction) + per-run output store (large
    // tool outputs are offloaded to a handle instead of truncated, and recovered on demand).
    const taskState = new TaskStateTracker({ goal: task });
    const outputStore = new ToolOutputStore();
    // The read_output/grep_output tools are meta (always in the subset) so the model can pull an
    // offloaded output back once it sees a handle.
    const baseTools = [...this.tools, ...outputStoreTools(outputStore)];

    // J.2: subset the tools shown to the model to what this task's skills need, so a large
    // catalog does not invite tool-overload. Opt-in: with no skills configured, the full set is
    // used unchanged. Uncategorized tools (memory) stay available; `finish` always does.
    // J.2b: with a subset in force, the model needs a way to say "I need something I was
    // not given" instead of doing the wrong thing with a tool it has. Only offered when a
    // subset exists: with the full catalog there is nothing to find.
    const subsetting = Boolean(this.opts.skills?.length);
    // Computed ONCE and shared by the tool subset and the guides. Two answers to "which
    // skills are active" is how a model gets a tool from one skill and the instructions
    // from another, and the transcript looks entirely reasonable.
    const activeSkills = subsetting ? activeSkillsFor(task, this.opts.skills!) : [];
    let activeTools = subsetting
      ? [
          ...selectActiveTools(task, baseTools, this.opts.skills!, { alwaysNames: [FINISH_TOOL] }),
          findToolsTool,
        ]
      : baseTools;

    // J.2c: the active skills' guides, as their own system message AFTER the identity.
    // Separate on purpose: a reader of this transcript can see where the persona's own
    // words end and quoted third-party material begins, and so can the model.
    const guideBlock = this.opts.skillGuides?.size
      ? renderGuides(guidesFor(activeSkills, this.opts.skillGuides))
      : null;

    const messages: ChatMessage[] = [
      { role: "system", content: this.systemPrompt() },
      ...(guideBlock ? [{ role: "system" as const, content: guideBlock }] : []),
      ...(this.opts.priorMessages ?? []),
      // V7.A1: environment changes are SYSTEM speech, not the user's words.
      ...(this.opts.envNote ? [{ role: "system" as const, content: this.opts.envNote }] : []),
      { role: "user", content: task },
    ];
    this.lastMessages = messages; // reference; reflects the final state after the run

    // J.4c: plan before acting, when asked to. The anchor goes in as system speech so the
    // model is held to what it said it would do; a refused plan stops the run here, before
    // any tool has been called.
    if (this.opts.plan?.enabled) {
      const planning = await runPlanPhase(
        messages,
        {
          ask: async (planMessages) => {
            // No tools offered: this turn is for text, and a model handed tools during
            // planning calls one, which is the acting this phase exists to precede.
            const res = await requestToolCall(this.opts.llm, [...planMessages], [], this.preferFallback);
            tokens += res.usage?.total_tokens ?? 0;
            return res.text;
          },
          tools: activeTools,
          policy: this.policy,
          onOutcome: (outcome, attempt) =>
            bus.emit({
              type: "agent-think",
              text:
                outcome.kind === "proceed"
                  ? `[plan] accepted on attempt ${attempt}`
                  : `[plan] attempt ${attempt} ${outcome.kind}: ${outcome.feedback}`,
            }),
        },
        this.opts.plan,
      );

      if (!planning.ok) {
        // Stopped before the first tool call, and said so. `finished: false` with the reason
        // as the summary, because a caller that only reads `summary` must not be told the
        // work was done.
        watchdog.stop();
        bus.emit({ type: "agent-think", text: `[plan] run abandoned: ${planning.reason}` });
        return {
          summary: planning.reason,
          steps: 0,
          finished: false,
          budget: {
            steps: 0,
            tokens,
            costUsd: Number(estimateCostUsd(this.opts.llm.model, tokens).toFixed(4)),
            wallSeconds: Number(((Date.now() - startTime) / 1000).toFixed(1)),
            stoppedBy: "plan",
          },
        };
      }
      messages.push({ role: "system", content: planning.anchor });
    }

    const spent = (steps: number, goalMet = false, confidence?: number): AgentBudgetSpent => ({
      steps,
      tokens,
      costUsd: estimateCostUsd(this.opts.llm.model, tokens),
      wallSeconds: (Date.now() - startTime) / 1000,
      deniedCount,
      errorCount,
      progress: stepProgress,
      confidence,
      goalMet,
    });
    const report = (steps: number, stoppedBy: string | null): AgentBudgetReport => ({
      steps,
      tokens,
      costUsd: Number(estimateCostUsd(this.opts.llm.model, tokens).toFixed(4)),
      wallSeconds: Number(((Date.now() - startTime) / 1000).toFixed(1)),
      stoppedBy,
    });

    // J.3: reflect on a finished run. Opt-in (needs opts.postmortem) and best-effort by
    // contract, reflection must never crash a run. The trigger heuristic (in runPostmortem)
    // gates on hard-won successes, so a one-shot chat reply never reaches the LLM extractor.
    const maybePostmortem = async (outcome: AgentOutcome, step: number): Promise<void> => {
      const deps = this.opts.postmortem;
      const p = this.opts.personaPath;
      if (!deps || !p) return;
      try {
        const mode = readMode(loadPersona(p).frontmatter as Record<string, unknown>, p);
        const toolsUsed = [
          ...new Set(
            messages
              .filter((m) => m.role === "assistant" && m.tool_calls?.length)
              .flatMap((m) => (m.tool_calls ?? []).map((tc) => tc.function.name))
              .filter((n) => n !== FINISH_TOOL),
          ),
        ];
        const res = await runPostmortem(
          { outcome, steps: step, failuresBeforeSuccess: errorCount },
          {
            task,
            transcript: messages.map((m) => `${m.role}: ${m.content ?? ""}`).join("\n").slice(-6000),
            outcome,
            toolsUsed,
          },
          { personaPath: p, mode },
          deps,
        );
        if (res.write && res.write.outcome !== "blocked") {
          bus.emit({ type: "agent-think", text: `[post-mortem] skill ${res.write.outcome}: ${res.write.name}` });
        }
      } catch {
        /* reflection is additive; never let it take down the run */
      }
    };

    // Run the objective verifier on a candidate completion; returns whether to
    // accept (finish), retry, or stop, the maker≠checker gate.
    const verifyCompletion = async (summary: string): Promise<"accept" | "retry" | "stop"> => {
      if (verification.mode === "off" || verification.gates.length === 0) return "accept";
      bus.emit({ type: "verify-start", gates: verification.gates.length });
      const result = await runVerification(
        verification,
        { task, output: summary, transcript: messages.map((m) => `${m.role}: ${m.content}`).join("\n").slice(-6000) },
        { policy: this.policy, judge: this.opts.judge },
      );
      for (const r of result.results) bus.emit({ type: "verify-result", verifier: r.verifier, pass: r.pass, reason: r.reason });
      bus.emit({ type: "verify-complete", passed: result.passed, passes: result.passes, quorum: result.quorum });
      this.lastVerification = result;
      if (result.passed || verification.mode === "advisory") return "accept";
      // mode === blocking and failed:
      if (verification.onFail === "skip") return "accept";
      if (verification.onFail === "retry" && retriesLeft > 0) {
        retriesLeft--;
        messages.push({
          role: "user",
          content:
            `Verification FAILED (independent checker). Do not call finish until these pass:\n` +
            result.results.filter((r) => !r.pass).map((r) => `- ${r.verifier}: ${r.reason}`).join("\n") +
            `\nFix the issues, then finish.`,
        });
        return "retry";
      }
      return "stop";
    };

    try {
      for (let step = 1; step <= HARD_CEIL; step++) {
        // Budget / stop-condition gate BEFORE doing more work. Owns the step-boundary reasons
        // (max_steps / max_tokens / max_cost_usd / max_wall_seconds).
        const check = checkAgentBudget(spent(step - 1), budget);
        bus.emit({ type: "agent-budget", step: step - 1, tokens, costUsd: Number(estimateCostUsd(this.opts.llm.model, tokens).toFixed(4)), wallSeconds: Number(((Date.now() - startTime) / 1000).toFixed(1)) });
        if (check.shouldStop) {
          bus.emit({ type: "agent-stop-condition", reason: check.stopReason ?? "budget", step: step - 1 });
          const summary = budget.onExhaust === "summarize_and_stop" ? (lastText || `stopped: ${check.stopReason}`) : `stopped: ${check.stopReason}`;
          bus.emit({ type: "agent-finish", summary, steps: step - 1 });
          this.persist(task, "stopped", summary, step - 1, check.stopReason);
          return { summary, steps: step - 1, finished: false, budget: report(step - 1, check.stopReason), verification: this.lastVerification };
        }

        // K.07: honor an out-of-band abort. The watchdog enforces the WALL-CLOCK ceiling on a
        // timer, so a run that hangs INSIDE a tool call (where the boundary check above never
        // runs) is still stopped and recorded. Checked after the budget gate so the specific
        // boundary reasons win when both would fire.
        watchdog.check();
        if (watchdog.aborted) {
          const reason = watchdog.abortReason ?? "resource limit";
          bus.emit({ type: "agent-stop-condition", reason: "watchdog", step: step - 1 });
          const summary = lastText || `stopped: ${reason}`;
          bus.emit({ type: "agent-finish", summary, steps: step - 1 });
          this.persist(task, "stopped", summary, step - 1, "watchdog");
          return { summary, steps: step - 1, finished: false, budget: report(step - 1, "watchdog"), verification: this.lastVerification };
        }

        bus.emit({ type: "agent-step", step });

        // Context management: compact BEFORE sending if near the window (headroom).
        if (meter.pct >= compactThreshold) {
          const c = await compactMessages(messages, meter, { llm: this.opts.llm, threshold: compactThreshold, pinned: taskState.render() });
          if (c.compacted) {
            messages.length = 0;
            messages.push(...c.messages);
            bus.emit({ type: "context-compacted", removed: c.removed ?? 0, usedAfter: meter.used });
          }
        }

        const res = await requestToolCall(this.opts.llm, messages, activeTools, this.preferFallback);
        if (res.usedFallback) this.preferFallback = true;
        tokens += res.usage?.total_tokens ?? 0;
        this.spentTokens = tokens;
        this.spentCost = estimateCostUsd(this.opts.llm.model, tokens);
        meter.observe(res.usage);
        if (!res.usage) meter.estimate(messages);
        bus.emit({ type: "context-meter", used: meter.used, limit: meter.limit, pct: Number(meter.pct.toFixed(3)) });
        if (res.text) {
          lastText = res.text;
          bus.emit({ type: "agent-think", text: res.text });
        }

        // No tool call → the model answered in prose; treat as a completion candidate.
        if (res.toolCalls.length === 0) {
          // Persist the assistant's reply into the transcript BEFORE returning, so
          // `lastMessages` (→ the REPL's ctx.conversation) carries it. Without this the
          // next turn sees only the stacked user questions and re-answers them all.
          messages.push({ role: "assistant", content: res.text || "" });
          const decision = await verifyCompletion(res.text || "(no action)");
          if (decision === "accept") {
            bus.emit({ type: "agent-finish", summary: res.text || "", steps: step });
            this.persist(task, "success", res.text || "", step, "goal_met");
            await maybePostmortem("success", step);
            return { summary: res.text || "", steps: step, finished: true, budget: report(step, "goal_met"), verification: this.lastVerification };
          }
          if (decision === "stop") {
            bus.emit({ type: "agent-finish", summary: "verification failed", steps: step });
            this.persist(task, "verification_failed", "verification failed", step, "verification_failed");
            return { summary: "verification failed", steps: step, finished: false, budget: report(step, "verification_failed"), verification: this.lastVerification };
          }
          continue; // retry
        }

        // Echo the assistant's tool calls into the transcript (native shape).
        messages.push({
          role: "assistant",
          content: res.text,
          tool_calls: res.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: JSON.stringify(tc.args) },
          })),
        });

        let producedWork = false;
        let finishedThisStep: { summary: string } | null = null;
        // J.4: signature of the first call in this step that did NOT make progress, so the
        // loop breaker can tell "same failing action again" from "a different attempt".
        let firstFailSig: string | null = null;
        const noteFail = (call: ToolCall): void => {
          if (firstFailSig === null) firstFailSig = toolSignature(call.name, call.args);
        };
        for (const call of res.toolCalls) {
          if (call.name === FINISH_TOOL) {
            finishedThisStep = { summary: typeof call.args.summary === "string" ? call.args.summary : "done" };
            // a finish call still needs a tool-result entry for transcript validity
            messages.push({ role: "tool", tool_call_id: call.id, name: call.name, content: "finish requested" });
            continue;
          }

          // Resolve from the tools this run actually offered (memory + output-store are per-run,
          // closured over their deps), falling back to the global registry. The old global-only
          // lookup could not find a per-run tool the model was shown.
          // J.2b: searching is handled here rather than by the tool's own execute, because
          // the result changes what the model may call next, and a tool cannot reach the
          // loop's subset. It is a lookup with no side effect, so it runs before the gate:
          // there is nothing to authorise. What it FINDS still faces its own gate when
          // called, which is what keeps the narrowing from being decorative.
          if (call.name === FIND_TOOLS_TOOL) {
            const query = typeof call.args.query === "string" ? call.args.query : "";
            const matches = findTools(query, baseTools, activeTools);
            activeTools = expandActive(activeTools, baseTools, matches);
            bus.emit({ type: "tool-result", tool: call.name, ok: true, output: `${matches.length} match(es)` });
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              name: call.name,
              content: describeMatches(query, matches),
            });
            continue;
          }

          const tool = activeTools.find((t) => t.name === call.name) ?? toolByName(call.name);
          if (!tool) {
            errorCount++;
            noteFail(call);
            messages.push({ role: "tool", tool_call_id: call.id, name: call.name, content: `error: unknown tool '${call.name}'` });
            continue;
          }

          bus.emit({ type: "tool-propose", tool: call.name, args: call.args });

          // FR.4 PreToolUse hooks (blocking-capable): a user hook may veto the
          // call BEFORE the gate, exit 2 or {"decision":"block"} denies it.
          if (this.hooksConfig) {
            const pre = await runHooks(
              "PreToolUse",
              { tool: call.name, args: call.args },
              this.hooksConfig,
              call.name,
            );
            if (pre.blocked) {
              deniedCount++;
              noteFail(call);
              interceptor.recordBlocked(call.name, "deny", "blocked by PreToolUse hook");
              bus.emit({ type: "tool-verdict", tool: call.name, decision: "deny", reason: "blocked by PreToolUse hook" });
              messages.push({ role: "tool", tool_call_id: call.id, name: call.name, content: "denied by PreToolUse hook" });
              continue;
            }
          }

          const verdict = tool.gate(call.args, this.policy);
          // K.04: tighten the coarse sandbox verdict with the HITL risk matrix (posture × taint ×
          // reversibility × sensitivity). Consent can only make it STRICTER: a destructive action
          // while the context is malicious-tainted is denied even if the gate would allow it.
          const consented = tightenVerdict(verdict.decision, {
            klass: verdict.class,
            sandbox: this.policy.sandbox as SandboxPosture,
            taint: contextTaint,
          });
          const decisionReason = consented.decision !== verdict.decision
            ? `consent: ${consented.reasons.join("; ")}`
            : verdict.reason;
          bus.emit({ type: "tool-verdict", tool: call.name, decision: consented.decision, reason: decisionReason });

          let output: string;
          if (consented.decision === "deny") {
            deniedCount++;
            noteFail(call);
            interceptor.recordBlocked(call.name, "deny", decisionReason);
            output = `denied by policy: ${decisionReason}`;
          } else if (consented.decision === "ask") {
            const decision = this.opts.onApproval ? await this.opts.onApproval(call, verdict) : "deny";
            if (decision === "deny") {
              deniedCount++;
              noteFail(call);
              interceptor.recordBlocked(call.name, "ask", "user denied");
              output = "denied by user";
            } else {
              if (decision === "always") this.policy.allow.push(escapeRegExp(firstArg(call)));
              const r = await interceptor.run(tool, call);
              output = r.output;
              contextTaint = maxTaint(contextTaint, r.outputVerdict);
              if (r.ok) producedWork = true;
              else { errorCount++; noteFail(call); }
            }
          } else {
            const r = await interceptor.run(tool, call);
            output = r.output;
            contextTaint = maxTaint(contextTaint, r.outputVerdict);
            if (r.ok) producedWork = true;
            else { errorCount++; noteFail(call); }
          }

          // J.6: track the run's task state (survives compaction) and offload a large output
          // to a handle instead of pushing 100k of it into the context.
          if (typeof call.args.path === "string") taskState.noteFile(call.args.path);
          if (output.startsWith("error") || output.startsWith("denied")) taskState.noteError(`${call.name}: ${output.slice(0, 120)}`);
          const shown = outputStore.offload(call.name, output).text;
          messages.push({ role: "tool", tool_call_id: call.id, name: call.name, content: shown });
        }

        stepProgress = producedWork ? 1 : 0;

        // J.4: loop breaker. A finish this step short-circuits below, so only assess when the
        // run is actually continuing.
        if (!finishedThisStep) {
          breaker.record({ producedWork, failingSignature: producedWork ? null : firstFailSig });
          const bv = breaker.assess();
          if (bv.action === "nudge") {
            // One hint to change approach, as SYSTEM speech (not the user's words).
            messages.push({ role: "system", content: `Loop check: ${bv.reason}. Step back and try a genuinely different approach, or call finish if the task cannot proceed.` });
            bus.emit({ type: "agent-think", text: `[loop-breaker] ${bv.reason}` });
          } else if (bv.action === "stop") {
            bus.emit({ type: "agent-stop-condition", reason: "loop_breaker", step });
            const summary = lastText || `stopped: ${bv.reason}`;
            bus.emit({ type: "agent-finish", summary, steps: step });
            this.persist(task, "stopped", summary, step, "loop_breaker");
            return { summary, steps: step, finished: false, budget: report(step, "loop_breaker"), verification: this.lastVerification };
          }
        }

        if (finishedThisStep) {
          const decision = await verifyCompletion(finishedThisStep.summary);
          if (decision === "accept") {
            bus.emit({ type: "agent-finish", summary: finishedThisStep.summary, steps: step });
            this.persist(task, "success", finishedThisStep.summary, step, "goal_met");
            await maybePostmortem("success", step);
            return { summary: finishedThisStep.summary, steps: step, finished: true, budget: report(step, "goal_met"), verification: this.lastVerification };
          }
          if (decision === "stop") {
            bus.emit({ type: "agent-finish", summary: "verification failed", steps: step });
            this.persist(task, "verification_failed", "verification failed", step, "verification_failed");
            return { summary: "verification failed", steps: step, finished: false, budget: report(step, "verification_failed"), verification: this.lastVerification };
          }
          // retry: loop continues; the failure note is already in messages.
        }
      }

      bus.emit({ type: "agent-finish", summary: `stopped at hard ceiling`, steps: HARD_CEIL });
      this.persist(task, "stopped", "stopped at hard ceiling", HARD_CEIL, "hard_ceiling");
      return { summary: `stopped at hard ceiling`, steps: HARD_CEIL, finished: false, budget: report(HARD_CEIL, "hard_ceiling"), verification: this.lastVerification };
    } catch (err) {
      bus.emit({ type: "agent-error", message: (err as Error).message });
      this.persist(task, "error", `agent error: ${(err as Error).message}`, 0, "error");
      return { summary: `agent error: ${(err as Error).message}`, steps: 0, finished: false, budget: report(0, "error"), verification: this.lastVerification };
    } finally {
      // K.07: always disarm the out-of-band timer when the run ends, on any exit path.
      watchdog.stop();
    }
  }

  private lastVerification?: ConsensusResult;

  // K.03/K.10: execution + untrusted-output scan + PostToolUse now live in the interceptor
  // (`security/interceptor.ts`), the single path to the OS. This holds the run's forensic log
  // so callers/tests can read and verify the security audit.
  private lastForensicLog?: ForensicLog;
  get forensic(): ReadonlyArray<Readonly<ForensicRecord>> {
    return this.lastForensicLog?.entries() ?? [];
  }

  /** FR.4: lazily-loaded `.personaxis/hooks.json` (null = no persona path). */
  private get hooksConfig(): HooksConfig | null {
    if (this._hooksConfig === undefined) {
      this._hooksConfig = this.opts.personaPath ? readHooksConfig(this.opts.personaPath) : null;
    }
    return this._hooksConfig;
  }
  private _hooksConfig: HooksConfig | null | undefined;
}

function firstArg(call: ToolCall): string {
  const v = call.args.command ?? call.args.path ?? "";
  return typeof v === "string" ? v : "";
}
