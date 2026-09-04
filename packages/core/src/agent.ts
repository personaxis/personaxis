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
import { ensureState, loadPersona } from "./persona.js";
import { ContextMeter, compactMessages, cachedContextWindow, resolveContextWindow } from "./context.js";
import { LoopBreaker, toolSignature } from "./loop-breaker.js";
import { ForensicLog, type ForensicRecord } from "./security/forensic-log.js";
import { ToolInterceptor } from "./security/interceptor.js";
import { Watchdog } from "./security/watchdog.js";
import { runPlanPhase, type PlanPhaseConfig } from "./plan-run.js";
import {
  buildTrace,
  describeTrace,
  traceIsInteresting,
  unambiguousSteps,
  type CausalTrace,
  type TraceNode,
} from "./causal-trace.js";
import { tightenVerdict, maxTaint, type ContextTaint, type SandboxPosture } from "./security/consent.js";
import { accept, type Accepted } from "./security/taint.js";
import { actionClassesFor } from "./enforcement/action-classes.js";
import type { ExecutablePolicy } from "./enforcement/policy-compile.js";
import { freezeCall } from "./gate/call.js";
import { capabilityGuard, requirePolicy } from "./gate/capability.js";
import { ask, deny, type GuardOutcome } from "./gate/verdict.js";
import { runGuards } from "./gate/waterfall.js";
import { breakerGuard, nudgeFor } from "./run/breaker-guard.js";
import { authorId } from "./record/entry.js";
import { Kernel, type PermissionKey } from "./kernel/index.js";
import { grantedPermissions, mountBuiltins, type ToolBench } from "./tools/mounted.js";

/**
 * Where a compaction is allowed to happen.
 *
 * Named rather than implied by a threshold, because the two are not the same event.
 * One is a decision taken before work starts, where rewriting the transcript is
 * cheapest. The other is a window that filled anyway, which is a fact worth
 * reporting rather than a step that quietly costs more than the last one.
 */
export type CutPoint = "turn-start" | "window-full";

/** One compaction that happened, with what it cost. */
export interface CompactionRecord {
  readonly cut: CutPoint;
  readonly step: number;
  readonly removed: number;
  /** Tokens in the window before and after, so the saving is a number. */
  readonly before: number;
  readonly after: number;
}

/**
 * The point where the window is full enough that not compacting fails the turn.
 *
 * Above the ordinary threshold on purpose: everything between the two is handled at
 * the start of a turn, and reaching this one means that was not enough.
 */
const HARD_COMPACT_THRESHOLD = 0.92;

/**
 * A tool's own verdict, as a guard.
 *
 * The translation is one-way on purpose, and the asymmetry is the point: an `allow`
 * becomes nothing at all, because a guard has no way to say allow and should not.
 * Allow is the absence of an objection. Keeping that shape is what stops the tool
 * gate from being able to rescue a call another guard already refused.
 */
function fromToolGate(verdict: CommandVerdict): GuardOutcome {
  if (verdict.decision === "allow") return undefined;
  const rule = `tool:${verdict.class.destructive ? "destructive" : "sandbox"}`;
  return verdict.decision === "deny" ? deny(rule, verdict.reason) : ask(rule, verdict.reason);
}

export type ApprovalDecision = "approve" | "deny" | "always";
export type OnApproval = (call: ToolCall, verdict: CommandVerdict) => Promise<ApprovalDecision>;

export interface AgentOptions {
  /** LLM endpoint/model for tool-calling (required, no offline agent). */
  llm: ToolCallConfig;
  /** Sandbox/approval policy (from policyFromFrontmatter). */
  policy?: Policy;
  /**
   * The persona's compiled policy, which is the first axis of the gate.
   *
   * Optional in the type and NOT optional in effect: without it `requirePolicy`
   * refuses every call, which is the intended reading of "a run with no policy". It
   * is optional here because a caller that has no persona at all, a bare loop in a
   * test, should be able to construct one and see the refusals rather than a type
   * error about a document it does not have.
   *
   * Derived by `agentOptionsFor` from the persona's own frontmatter, beside the budget
   * and the verification block, for the reason that file gives: these are properties
   * of who the persona is, and a caller that could pass them would be changing the
   * persona without editing it.
   */
  capability?: ExecutablePolicy;
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
   * What this persona is allowed to do, as kernel permissions (E12).
   *
   * When present, the built-in catalogue is assembled BY THE KERNEL: each tool is a
   * component that declares the permission it needs, and a tool whose permission is
   * absent is never offered rather than offered and then refused. That difference
   * matters: a model handed a tool it may not use will use it, be refused, and try
   * again in a slightly different shape, which is the loop the breaker exists to stop.
   *
   * Absent means every built-in, which is what every caller got before this existed.
   * Withholding is a decision somebody makes, not a default they fall into.
   */
  permissions?: readonly PermissionKey[];
  /**
   * Tools contributed from outside the engine, added to whatever catalogue results.
   *
   * Separate from `tools` because they answer different questions. `tools` says "the
   * catalogue IS this", which a caller wanting a three-tool agent needs. This says
   * "and also these", which is what every contributor needs: an MCP server mounted by
   * `personaxis mcp add`, and whatever else arrives by protocol later.
   */
  extraTools?: ToolSpec[];
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
  /**
   * Every compaction this run did, with where and what it cost.
   *
   * Reported rather than counted internally, because E6's whole point is that a
   * compaction is measured and not supposed. Empty is the ordinary case and says so:
   * a run that never filled its window is different from one whose measurements were
   * never taken, and a caller cannot tell those apart from a number alone.
   */
  compactions: readonly CompactionRecord[];
  /**
   * Why this run did what it did, when there is anything to say.
   *
   * Built at write time from the plan's declared tools and the calls that ran, never
   * reconstructed afterwards. A call the plan did not unambiguously name lands under
   * , which is the honest answer and also the interesting one: a run
   * that departed from its plan is the run somebody is investigating.
   */
  trace: CausalTrace;
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
  /**
   * The persona's compiled limits, which is the capability axis on this path.
   *
   * Held apart from `policy` because they are different documents answering different
   * questions. `policy` is the environment: which root this run may write under, which
   * sandbox posture the host offers. This is the persona: what it may never do,
   * whatever machine it happens to be on. Folding them would make one of the two
   * unwritable from where its author sits.
   */
  private readonly capability?: ExecutablePolicy;
  private readonly tools: ToolSpec[];
  /**
   * The kernel bench, when this persona declared permissions.
   *
   * Held rather than closed, because closing it unwinds every component scope and
   * empties the catalogue it produced. It lives as long as the agent does.
   */
  private readonly bench?: ToolBench;
  private preferFallback = false;

  constructor(private readonly opts: AgentOptions) {
    this.bus = opts.bus ?? new EventBus();
    this.policy = opts.policy ?? DEFAULT_POLICY;
    this.capability = opts.capability;
    // E12: the built-ins come from the kernel when the persona declared permissions.
    //
    // `mountBuiltins` makes each tool a component that names the permission it needs,
    // so the catalogue IS the set of components the kernel could activate. A withheld
    // permission removes its tools by unwinding their scope, with no removal code
    // anywhere: that is `EffectScope` doing the job it was written for.
    //
    // The bench is held for the life of the agent rather than closed here, because
    // closing it would unwind every scope and empty the catalogue it just produced.
    if (opts.permissions) {
      this.bench = mountBuiltins(new Kernel(), grantedPermissions(opts.permissions));
    }
    const builtins = this.bench ? [...this.bench.tools] : TOOLS;

    // With a persona attached, the loop also gets the read-only memory tools
    // (memory_search / memory_get), honoring the persona's runtime.memory knobs.
    let tools = opts.tools ?? builtins;
    if (!opts.tools && opts.personaPath) {
      try {
        const fm = loadPersona(opts.personaPath).frontmatter as Record<string, unknown>;
        tools = [...builtins, ...memoryTools(opts.personaPath, readMemoryKnobs(fm), { sessionId: opts.sessionId, llm: opts.llm })];
      } catch {
        /* an unreadable persona must not kill the agent; memory tools are additive */
      }
    }
    // E3: tools from elsewhere, added rather than substituted.
    //
    // `tools` REPLACES the catalogue, which is right for a caller that wants exactly
    // three tools and wrong for every source that contributes some. Mounting MCP
    // servers through it would have silently dropped the built-ins and the memory
    // tools, and the failure would look like a persona that forgot how to read a file.
    //
    // Names collide by accident and never silently. A contributed tool that repeats
    // one already in the catalogue is dropped, because the model chooses by name and
    // two entries under one name is a coin flip about which code runs. MCP tools carry
    // their server's prefix so they cannot reach this by ordinary means, but a caller
    // could contribute anything and the rule has to hold for what it is given.
    if (opts.extraTools?.length) {
      const known = new Set(tools.map((tool) => tool.name));
      tools = [...tools, ...opts.extraTools.filter((tool) => !known.has(tool.name))];
    }
    this.tools = tools;
  }

  /**
   * The part of the prompt that does not change between turns.
   *
   * E5 split this from what the persona currently remembers, and the split is the
   * whole of prompt caching rather than a tidiness pass. A provider caches a PREFIX:
   * it charges 1.25x to write one and 0.1x to read it, and the discount applies only
   * up to the first token that differs. Recent memory used to sit inside this string,
   * and recent memory changes every time a turn is recorded, so the prefix differed
   * at the memory block on every single turn and no cache could ever hit.
   *
   * Everything here is fixed for the life of a session: the guard, the identity
   * document, the environment, the awareness block, the standing goal. What the
   * persona knows right now goes after it, in its own message, where it costs a cache
   * write of its own and nothing else.
   */
  private stablePrefix(): string {
    return [
      GUARD,
      "",
      "# Identity",
      (this.opts.personaBody ?? "").slice(0, 5000),
      "",
      "# Environment",
      `os: ${process.platform} (use commands valid for this OS, e.g. PowerShell/cmd on win32)`,
      `workspace: ${this.policy.workspaceRoot}`,
      // E20: the confinement mode is NOT here any more. See `scopeOfTheMoment`.
      this.opts.awareness ? `\n${this.opts.awareness}` : "",
      this.opts.goal ? `\n# Standing goal\n${this.opts.goal}` : "",
    ].filter(Boolean).join("\n");
  }

  /**
   * What this persona may do RIGHT NOW, as an execution-context contribution.
   *
   * E20, and it is the finding that cuts against us. The study measured it: with the
   * confinement mode written into the stable system prompt, **five of twelve turns
   * ended with no tool call at all**. Telling an agent its limits can stop it acting.
   *
   * The resolution is not to hide the limits, which would leave a persona guessing at
   * what it may do and being refused for guessing wrong. It is WHERE they are told.
   * A system prompt is who you are, and a restriction written there reads as part of
   * the identity: "I am a restricted agent". The same sentence in the execution
   * context reads as a fact about this moment: "right now, this". The study's own
   * delegation tells its children exactly the same things and keeps the system prompt
   * identical, which is where the answer came from.
   *
   * It also has to be here for the reason E5 cares about: the posture changes when
   * somebody presses shift+tab, and anything that changes per turn belongs on the far
   * side of everything that does not, or the prefix stops matching and the cache never
   * reads.
   *
   * What is NOT yet measured is whether moving it fixes the paralysis. That needs a
   * real model over a dozen turns, and it is `E28`.
   */
  private scopeOfTheMoment(): string {
    return [
      "# Right now",
      `sandbox: ${this.policy.sandbox} · approval: ${this.policy.approval}`,
      "This is the scope of this turn, not a description of who you are. Act within it.",
    ].join("\n");
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
      const st = ensureState(handle);
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
   * Persist the run into the EXISTING memory model (no separate STATE.md): the run
   * summary becomes an episodic memory entry (honoring memory.types.episodic), which
   * the semantic-consolidation step folds into memory.md.
   *
   * It no longer writes `state.json`'s `agent_session`, and the stop reason it took in
   * order to do that is gone with it. That block is printed from the record now, folded
   * over the turns themselves; writing it here as well made two owners of one fact.
   * Measured on a real turn: this wrote `stop_reason: "goal_met"` while the projection
   * said `answered`, and the file flip-flopped between them as the turn and the next
   * coordinate move landed. The record holds the turn, its question, its ending and its
   * price, so the record is what says.
   */
  private persist(task: string, outcome: AgentOutcome, summary: string, step: number): void {
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
          // The engine's own account of a run it just watched end, not a quote of any
          // one participant: the same provenance the episodic entry above carries.
          owner: "synthesis",
        });
      }
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
    // E6: what each compaction cost, so the caller is told rather than trusting
    // that a run which felt slow did or did not rewrite its own transcript.
    const compactions: CompactionRecord[] = [];
    // E9: the material a causal trace is built from, collected as it happens.
    //
    // At write time rather than reconstructed afterwards, which is the design decision
    // `causal-trace.ts` opens with: a reconstruction matches a call to the nearest plan
    // step by time, and is right until a step retries or the model works out of order,
    // and then it confidently attributes an action to an intention it never had.
    const intents = new Map<number, string>();
    const stepOfTool = new Map<string, number>();
    const traceNodes: TraceNode[] = [];
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

    // E5: the stable half first, then what changes. The order is the cache.
    //
    // A provider matches a prefix and stops at the first token that differs, so
    // anything volatile ahead of something stable makes the stable part uncacheable
    // too. Memory is the volatile part and it used to be inside the identity message,
    // which meant the identity, the guard and the awareness block were re-read from
    // scratch on every turn of every session.
    const remembered = this.resumeContext();
    const messages: ChatMessage[] = [
      { role: "system", content: this.stablePrefix() },
      ...(guideBlock ? [{ role: "system" as const, content: guideBlock }] : []),
      // After the guides, because a guide is fixed for the session too and memory is
      // not. Everything that changes per turn belongs on the far side of everything
      // that does not.
      ...(remembered.trim() ? [{ role: "system" as const, content: remembered }] : []),
      // E20: the confinement of this turn, out of the identity and into the moment.
      { role: "system" as const, content: this.scopeOfTheMoment() },
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
          compactions,
          trace: buildTrace(intents, traceNodes),
        };
      }
      messages.push({ role: "system", content: planning.anchor });
      // E9: the plan's steps become the intentions a trace is read against, and the
      // tools they declare become the only honest way to attribute a call to one.
      planning.steps.forEach((step, index) => {
        intents.set(index + 1, step.note?.trim() || step.tool);
      });
      for (const [tool, step] of unambiguousSteps(planning.steps)) stepOfTool.set(tool, step);
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
        // E9: the causal trace goes to the reflection, when there is one worth reading.
        //
        // This is what the trace was written for, and `traceIsInteresting` says which
        // runs qualify: a run that went exactly to plan tells a reflecting persona
        // nothing the outcome does not already carry. A step that failed, or work that
        // happened outside the plan entirely, is the part worth abstracting a lesson
        // from, and it is the part a raw transcript buries.
        const causal = buildTrace(intents, traceNodes);
        const reflection = traceIsInteresting(causal)
          ? `${messages.map((m) => `${m.role}: ${m.content ?? ""}`).join("\n").slice(-5000)}\n\n## Why it went that way\n${describeTrace(causal)}`
          : messages.map((m) => `${m.role}: ${m.content ?? ""}`).join("\n").slice(-6000);

        const res = await runPostmortem(
          { outcome, steps: step, failuresBeforeSuccess: errorCount },
          {
            task,
            transcript: reflection,
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
      // E9: verification belongs in the trace, because "the plan said to do this, it was
      // done, and the check said it did not work" is the shape of the answer somebody is
      // usually after. It carries no plan step: it is about the run, not about one step.
      traceNodes.push({
        kind: "verification",
        seq: traceNodes.length,
        label: `${result.passes}/${result.quorum} gates`,
        ok: result.passed,
      });
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
          this.persist(task, "stopped", summary, step - 1);
          return { summary, steps: step - 1, finished: false, budget: report(step - 1, check.stopReason), verification: this.lastVerification, compactions, trace: buildTrace(intents, traceNodes) };
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
          this.persist(task, "stopped", summary, step - 1);
          return { summary, steps: step - 1, finished: false, budget: report(step - 1, "watchdog"), verification: this.lastVerification, compactions, trace: buildTrace(intents, traceNodes) };
        }

        bus.emit({ type: "agent-step", step });

        // E6: compaction happens at a named cut point, and is counted.
        //
        // It used to run on any step whose meter had crossed the threshold, which is
        // "somewhere in the middle of the work, whenever". Two costs, and the second
        // is the one nobody sees. A summarised transcript is a different transcript,
        // so every token after the prefix has to be re-read by the provider: the
        // compaction that saved context spent the cache. And a compaction mid-chain
        // rewrites the history a tool call is still reasoning about.
        //
        // So there are exactly two cut points and they are named. `turn-start` is the
        // cheap, predictable one: before any work, where a rewrite costs the least.
        // `window-full` is the safety valve, and it is the one that gets counted and
        // reported, because reaching it means the first one was not enough and that
        // is a fact about this persona rather than an accident of this run.
        const cut: CutPoint | null =
          step === 1 && meter.pct >= compactThreshold
            ? "turn-start"
            : meter.pct >= HARD_COMPACT_THRESHOLD
              ? "window-full"
              : null;
        if (cut) {
          const before = meter.used;
          const c = await compactMessages(messages, meter, {
            llm: this.opts.llm,
            threshold: cut === "turn-start" ? compactThreshold : HARD_COMPACT_THRESHOLD,
            pinned: taskState.render(),
          });
          if (c.compacted) {
            messages.length = 0;
            messages.push(...c.messages);
            compactions.push({ cut, step, removed: c.removed ?? 0, before, after: meter.used });
            bus.emit({ type: "context-compacted", removed: c.removed ?? 0, usedAfter: meter.used });
          }
        }

        // E4: the text as it arrives, rather than a turn that blocks until the whole
        // reply lands. A screen showing a spinner for forty seconds and a screen
        // showing the persona thinking are the same run and not the same product.
        //
        // Only on the step path. The plan phase above asks a shaped question and
        // discards the prose, so streaming it would put a draft plan on screen that
        // nothing else ever refers to.
        const res = await requestToolCall(
          { ...this.opts.llm, onDelta: (text) => bus.emit({ type: "agent-delta", text }) },
          messages,
          activeTools,
          this.preferFallback,
        );
        if (res.usedFallback) this.preferFallback = true;
        tokens += res.usage?.total_tokens ?? 0;
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
            this.persist(task, "success", res.text || "", step);
            await maybePostmortem("success", step);
            return { summary: res.text || "", steps: step, finished: true, budget: report(step, "goal_met"), verification: this.lastVerification, compactions, trace: buildTrace(intents, traceNodes) };
          }
          if (decision === "stop") {
            bus.emit({ type: "agent-finish", summary: "verification failed", steps: step });
            this.persist(task, "verification_failed", "verification failed", step);
            return { summary: "verification failed", steps: step, finished: false, budget: report(step, "verification_failed"), verification: this.lastVerification, compactions, trace: buildTrace(intents, traceNodes) };
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
          // Whether THIS call did real work, which is what the breaker now records.
          //  stays as the step-level answer the budget reads.
          let callProduced = false;
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

          // E2: the tool's own gate is now ONE guard among several, not the decision.
          //
          // It used to be the whole answer here, and the consequence was that the
          // persona's compiled policy governed every agent EXCEPT ours. `deny`, `allow`,
          // its hard limits, its prohibited behaviours and its egress list were enforced
          // on a Claude Code or a Codex driven through the daemon, and enforced nowhere
          // on the loop this product ships. Measured on 2026-09-04: `gate/waterfall.ts`
          // had exactly one caller, `enforcement-service.ts`, which is the daemon.
          //
          // The tool gate stays, because it answers something the policy cannot: whether
          // this path escapes the workspace root of THIS run. It just answers alongside
          // the others now, and the verdict is the lowest of them.
          const verdict = tool.gate(call.args, this.policy);
          const argsText = JSON.stringify(call.args ?? {});
          const decided = runGuards(
            [
              // Absent policy is a refusal with a name in the list, not a branch
              // somewhere in this loop that a reader has to find.
              requirePolicy(this.capability),
              ...(this.capability ? [capabilityGuard(this.capability)] : []),
              // E22: a stop is a refusal, so it belongs here, and since the breaker is
              // recorded per CALL it can actually be seen from here.
              //
              // E10 put this in and took it back out, measured: with the breaker
              // recorded once per step, and the loop returning the moment it said stop,
              // a guard here never saw one. It sat in the list, passed every test, and
              // refused nothing, which reads as covered and is worse than absent.
              //
              // Per call, the second call of a step sees what the first one did. A model
              // hammering the same refused call inside one step is stopped inside that
              // step, rather than after it.
              breakerGuard(breaker),
              { name: "tool", check: () => fromToolGate(verdict) },
            ],
            freezeCall({
              tool: call.name,
              argsText,
              actionClasses: actionClassesFor(call.name, argsText),
              turn: call.id,
            }),
          );

          // K.04: tighten the cascade's verdict with the HITL risk matrix (posture × taint ×
          // reversibility × sensitivity). Consent can only make it STRICTER: a destructive action
          // while the context is malicious-tainted is denied even if the gate would allow it.
          const consented = tightenVerdict(decided.verdict, {
            klass: verdict.class,
            sandbox: this.policy.sandbox as SandboxPosture,
            taint: contextTaint,
          });
          // Every reason, not the first. A call refused twice used to report once, and
          // somebody who widened one limit and found the call still refused, with no hint
          // why, concluded enforcement was broken.
          const gateReason =
            decided.contributions.map((entry) => entry.reason).join("; ") || verdict.reason;
          const decisionReason = consented.decision !== decided.verdict
            ? `consent: ${consented.reasons.join("; ")}`
            : gateReason;
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
              // E13: the value and the taint arrive together, from one call. There is
              // no expression that takes one and leaves the other.
              //
              // Annotated rather than inferred, and that is the brand doing its job:
              // `Tainted` is keyed by a symbol its module does not export, so the shape
              // is deliberately unspellable from here and inference has nothing to walk.
              // Naming the result is the cost of a boundary a caller cannot forge.
              const accepted: Accepted<string> = accept(r.output, contextTaint);
              output = accepted.value;
              contextTaint = accepted.taint;
              if (r.ok) { producedWork = true; callProduced = true; }
              else { errorCount++; noteFail(call); }
            }
          } else {
            const r = await interceptor.run(tool, call);
            const accepted: Accepted<string> = accept(r.output, contextTaint);
            output = accepted.value;
            contextTaint = accepted.taint;
            if (r.ok) { producedWork = true; callProduced = true; }
            else { errorCount++; noteFail(call); }
          }

          // E9: the call as a trace node, with the plan step that named its tool when
          // exactly one did. Ambiguous cases carry no step and read as "not part of the
          // plan", which is uncertain rather than wrong.
          traceNodes.push({
            kind: "tool-call",
            seq: traceNodes.length,
            label: `${call.name} ${JSON.stringify(call.args).slice(0, 80)}`,
            callId: call.id,
            ok: !output.startsWith("error") && !output.startsWith("denied"),
            ...(stepOfTool.has(call.name) ? { planStep: stepOfTool.get(call.name)! } : {}),
          });

          // J.6: track the run's task state (survives compaction) and offload a large output
          // to a handle instead of pushing 100k of it into the context.
          if (typeof call.args.path === "string") taskState.noteFile(call.args.path);
          if (output.startsWith("error") || output.startsWith("denied")) taskState.noteError(`${call.name}: ${output.slice(0, 120)}`);
          const shown = outputStore.offload(call.name, output).text;
          messages.push({ role: "tool", tool_call_id: call.id, name: call.name, content: shown });

          // E22: recorded per CALL, which is what makes the stop reachable.
          //
          // It used to be recorded once per step, after every call in it had run, and
          // the loop returned immediately on a stop. So `breakerGuard` could sit in the
          // cascade and never fire: by the time there was another call to refuse, the
          // run was over. Per call, the second call of a step sees what the first one
          // did, and a model hammering the same refused call inside one step is stopped
          // inside that step.
          //
          // The cost is real and was the reason to ask before doing it: a step with
          // several calls now reaches the threshold sooner than the same work spread
          // over several steps. That is measured in `loop-breaker-guard.test.ts` rather
          // than asserted here.
          breaker.record({
            producedWork: callProduced,
            failingSignature: callProduced ? null : toolSignature(call.name, call.args),
          });
        }

        stepProgress = producedWork ? 1 : 0;

        // J.4: loop breaker. A finish this step short-circuits below, so only assess when the
        // run is actually continuing.
        if (!finishedThisStep) {
          const bv = breaker.assess();
          const nudge = nudgeFor(bv);
          if (nudge) {
            // E10: the hint carries WHO put it there.
            //
            // It went in unlabelled, which renders in a transcript as a real request
            // from the person. That is the fourth independent sighting of the same
            // rule in this repository, and the reason it is an invariant of the record
            // rather than a precaution in one file.
            messages.push({
              role: "system",
              content:
                `[${authorId(nudge.author)}] Loop check: ${nudge.text}. ` +
                "Step back and try a genuinely different approach, or call finish if the task cannot proceed.",
            });
            bus.emit({ type: "agent-think", text: `[loop-breaker] ${nudge.text}` });
          } else if (bv.action === "stop") {
            bus.emit({ type: "agent-stop-condition", reason: "loop_breaker", step });
            const summary = lastText || `stopped: ${bv.reason}`;
            bus.emit({ type: "agent-finish", summary, steps: step });
            this.persist(task, "stopped", summary, step);
            return { summary, steps: step, finished: false, budget: report(step, "loop_breaker"), verification: this.lastVerification, compactions, trace: buildTrace(intents, traceNodes) };
          }
        }

        if (finishedThisStep) {
          const decision = await verifyCompletion(finishedThisStep.summary);
          if (decision === "accept") {
            bus.emit({ type: "agent-finish", summary: finishedThisStep.summary, steps: step });
            this.persist(task, "success", finishedThisStep.summary, step);
            await maybePostmortem("success", step);
            return { summary: finishedThisStep.summary, steps: step, finished: true, budget: report(step, "goal_met"), verification: this.lastVerification, compactions, trace: buildTrace(intents, traceNodes) };
          }
          if (decision === "stop") {
            bus.emit({ type: "agent-finish", summary: "verification failed", steps: step });
            this.persist(task, "verification_failed", "verification failed", step);
            return { summary: "verification failed", steps: step, finished: false, budget: report(step, "verification_failed"), verification: this.lastVerification, compactions, trace: buildTrace(intents, traceNodes) };
          }
          // retry: loop continues; the failure note is already in messages.
        }
      }

      bus.emit({ type: "agent-finish", summary: `stopped at hard ceiling`, steps: HARD_CEIL });
      this.persist(task, "stopped", "stopped at hard ceiling", HARD_CEIL);
      return { summary: `stopped at hard ceiling`, steps: HARD_CEIL, finished: false, budget: report(HARD_CEIL, "hard_ceiling"), verification: this.lastVerification, compactions, trace: buildTrace(intents, traceNodes) };
    } catch (err) {
      bus.emit({ type: "agent-error", message: (err as Error).message });
      this.persist(task, "error", `agent error: ${(err as Error).message}`, 0);
      return { summary: `agent error: ${(err as Error).message}`, steps: 0, finished: false, budget: report(0, "error"), verification: this.lastVerification, compactions, trace: buildTrace(intents, traceNodes) };
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
