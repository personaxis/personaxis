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
import { DEFAULT_POLICY, effectiveApproval, type CommandVerdict, type Policy } from "./sandbox.js";
import { FINISH_TOOL, toolByName, TOOLS, validateToolArgs, type ToolSpec } from "./tools/registry.js";
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
import { TaskStateTracker, type SubTask } from "./task-state.js";
import { applyTaskUpdate, UPDATE_TASKS_TOOL, updateTasksTool } from "./tools/update-tasks.js";
import { ASK_PERSON_TOOL, askPersonTool, readQuestion, renderQuestion, type PersonQuestion } from "./tools/ask-person.js";
import { DECIDE_INSTRUCTION, describeDecision, parseDecision, type Decision } from "./run/decide.js";
import { scaffoldFor } from "./run/destinations.js";
import { briefFor, MAX_ROUNDS_PER_TURN, nextRound, roundsOn, ROUND_REPLY_CHARS, type RoundTaken } from "./run/rounds.js";
import { DELEGATE_TOOL } from "./tools/delegate.js";
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
import { ContextMeter, compactMessages, cachedContextWindow, resolveContextWindow, type CacheReport } from "./context.js";
import type { CompactionPlan } from "./compaction/service.js";
import { LoopBreaker, toolSignature } from "./loop-breaker.js";
import { ForensicLog, type ForensicRecord } from "./security/forensic-log.js";
import { ToolInterceptor } from "./security/interceptor.js";
import { Watchdog } from "./security/watchdog.js";
import { runPlanPhase, type PlanPhaseConfig, type PlanPhaseResult } from "./plan-run.js";
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
import { LatencyMeter, type LatencyReport } from "./run/latency.js";
import { materialUsed } from "./run/material-use.js";
import { deliveredBy, deliveredIn, type Delivered } from "./run/delivered.js";
import { runDerivedChecks, type DeliveredVerification } from "./run/derived-checks.js";
import type { TurnCall } from "./run/vocabulary.js";
import { authorId } from "./record/entry.js";
import { writingToRecord } from "./record/transaction.js";
import { dirname as pathDirname, join as pathJoin } from "node:path";
import { Kernel, type PermissionKey } from "./kernel/index.js";
import { ALL_TOOL_PERMISSIONS, grantedPermissions, mountBuiltins, type ToolBench } from "./tools/mounted.js";

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
  /**
   * E25: which messages, named by unit, so this is auditable and not just counted.
   *
   * `removed` says how many and this says which. The loop does not write it anywhere:
   * a record entry is the runner's to write, and a loop that wrote its own would be
   * deciding both what happened and what is remembered about it. This is how the fact
   * leaves the loop.
   */
  readonly plan: CompactionPlan;
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

/**
 * What an approval handler answers, and why when it can say.
 *
 * C6b: the bare decision was the whole answer, and the runtime filled in the rest by
 * assuming. A denial was written down as `user denied` and shown to the model as
 * `denied by user` on EVERY path, including the ones where no user exists: an SDK
 * embedding, a daemon, and now a delegated sub-task, which refuses deterministically
 * BY RULE and never asks anybody. A record that names a person who was never consulted
 * is the same failure as a session ending attributed to a persona that was cut off
 * mid-sentence.
 *
 * A plain decision still answers, so no caller had to change. What a caller can now do
 * is say who decided, and the two that have a real person say so.
 */
export type ApprovalAnswer =
	| ApprovalDecision
	| { readonly decision: ApprovalDecision; readonly reason: string };

export type OnApproval = (call: ToolCall, verdict: CommandVerdict) => Promise<ApprovalAnswer>;

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
  /**
   * E17: a declared per-turn latency ceiling, in milliseconds.
   *
   * REPORTED, never enforced, and the asymmetry with the token budget is deliberate.
   * A token budget stops a run because spending more is the harm itself. Slowness is
   * not: killing a turn at nine seconds throws away the work it was about to finish,
   * and turns a provider having a bad minute into lost output. So this marks the run
   * and lets whoever declared the ceiling decide what a breach means.
   */
  latencyBudgetMs?: number;
  /**
   * E21: the tool subset for this SESSION, decided once by whoever opened it.
   *
   * When present it wins over per-task selection, and that is the point: the tool
   * declarations live in the provider's cached prefix, so a catalogue that changes
   * between turns pays a full cache write every time it moves. `finish` and
   * `find_tools` are added on top of whatever is named here, because a subset that
   * cannot end a turn or ask for what it lacks is worse than no subset.
   *
   * `sessionToolSubset` computes a reasonable one from the first task.
   */
  toolNames?: readonly string[];
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
  /**
   * E84: how a question the persona asks reaches a person, and the answer they give. Absent means nobody
   * can answer here (a service step, a delegated sub-task, a headless run), and the turn stops at the
   * question with it written down, which is David's decision P10 of E77.
   */
  onQuestion?: (question: PersonQuestion) => Promise<string>;
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
   * K5: the kernel to mount the built-ins on, when the caller owns one.
   *
   * Without it the agent makes its own and nobody else can reach it, which means nothing
   * can be withdrawn and no plugin can be contributed for the life of the agent. That is
   * what made `K5`'s rule unobservable through this class: a catalogue that cannot change
   * needs no rule about when it may.
   *
   * With one, the caller decides. An operator revoking a permission mid-session and a
   * plugin waking under `K2` both reach a running persona, and both then obey `K5`:
   * a removal at once, an addition at the next boundary.
   */
  kernel?: Kernel;
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
  /**
   * E34: absent when no provider call reported usage, rather than zero.
   *
   * Optional because the two are different facts and the difference is the whole reason
   * `TurnOutcome.cost` is optional one layer up. Required numbers meant a provider that
   * said nothing was recorded as having cost nothing, so the seam's careful "absent, not
   * zero" was defended in a place that could never see the difference.
   *
   * Steps and wall seconds stay required: the runtime counts those itself, whatever the
   * provider says.
   */
  tokens?: number;
  costUsd?: number;
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
   * E85: what the loop itself checked about what this turn left, and what it could not check.
   *
   * Separate from `verification`, which is the persona's own declared gates: this is what follows from the
   * deliverables (a page is run, a JSON is parsed) and runs whether or not the persona declared anything.
   * Absent when the turn left nothing, which is different from a turn that left something nobody checked,
   * and that difference is the state the record has to be able to show.
   */
  delivered?: DeliveredVerification;
  /**
   * E86: the rounds this run opened, each one a task of the list worked in a context with none of this one's
   * history. Absent when it opened none, which is every run on a model whose settings never asked for them.
   */
  rounds?: readonly RoundTaken[];
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
   * E80: every call that reached the gate, in order: what the gate decided, and what of the
   * persona's own material it used. The loop writes it nowhere, for the reason `compactions`
   * gives: a record entry is the runner's to write.
   *
   * Only calls the gate judged. A call to a tool that does not exist, one cut off, or one whose
   * arguments do not fit never reached a verdict, and `find_tools` and `finish` are not gated.
   */
  calls: readonly TurnCall[];
  /**
   * E81: the task list the persona kept this run, as it ended, with which done steps a call backs. Empty
   * when it kept none. The loop's own notes (files, errors) are not here: they are how the run survives
   * compaction, not something the persona said.
   */
  tasks: readonly SubTask[];
  /**
   * E83: the route the persona chose before acting, when its model's scaffold took the decision step and
   * the reply could be read. Absent otherwise: no step, or a reply that said no route, means nobody decided.
   */
  decision?: Decision;
  /**
   * E84: the questions the persona put to a person this run, in order, each with the answer when somebody
   * gave one. The last one without an answer is the question the run stopped at.
   */
  questions?: readonly (PersonQuestion & { readonly answer?: string })[];
  /**
   * E18: what the prompt cache did this run, as reported by the provider.
   *
   * `E5` shaped a stable prefix and `E6` gave compaction named cut points, and both
   * are bets that the provider serves that prefix from cache. Nothing observed
   * whether it does. A `hitRate` of zero and a `reported: false` look identical from
   * the outside and mean opposite things, so both travel.
   */
  cache: CacheReport;
  /**
   * E17: where the wall time went, split into the parts that move separately.
   *
   * `budget.wallSeconds` is the total, and a total is the one number that cannot
   * answer which part got slower. What no part claimed is reported as its own figure
   * rather than divided among the three, because attributing unmeasured time to
   * whatever happens to be instrumented is how a breakdown starts lying.
   */
  latency: LatencyReport;
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
  private tools: ToolSpec[];
  /**
   * The kernel bench, when this persona declared permissions.
   *
   * Held rather than closed, because closing it unwinds every component scope and
   * empties the catalogue it produced. It lives as long as the agent does.
   */
  private readonly bench?: ToolBench;
  /**
   * K5: everything in the catalogue that the kernel does not own.
   *
   * Memory tools, and whatever a caller contributed. They are not components, nothing can
   * withdraw them, and rebuilding them would mean re-reading a persona from disk every
   * turn to arrive at the same list. Held apart so a refresh replaces the kernel's half
   * and leaves this one exactly where it was.
   */
  private readonly notFromKernel: ToolSpec[] = [];
  private preferFallback = false;

  /**
   * K5: re-reads the bench, so what the model is shown is what the kernel now holds.
   *
   * A no-op without a bench, which is every caller that passed its own tools or none:
   * the catalogue is then the caller's and nothing here owns it.
   *
   * The memory tools and anything a caller added are NOT rebuilt. They are not components
   * and nothing can withdraw them, so rebuilding would mean re-reading a persona from
   * disk at every turn to arrive at the same list.
   */
  private refreshCatalogue(): void {
    if (!this.bench) return;
    this.bench.refresh();
    this.tools = [...this.bench.tools, ...this.notFromKernel];
  }

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
    if (opts.permissions || opts.kernel) {
      this.bench = mountBuiltins(
        opts.kernel ?? new Kernel(),
        grantedPermissions(opts.permissions ?? ALL_TOOL_PERMISSIONS),
      );
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
    // K5: which half a refresh may replace. Everything the kernel did not contribute is
    // kept apart now, while the two are still distinguishable; after this the catalogue
    // is one list and telling them apart would mean guessing by name.
    if (this.bench) {
      const fromKernel = new Set(this.bench.tools.map((tool) => tool.name));
      this.notFromKernel.push(...tools.filter((tool) => !fromKernel.has(tool.name)));
    }
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
    // E17: the three parts of a turn, timed apart, because a total cannot say which
    // one got slower and that is the only question anybody asks about latency.
    const clock = new LatencyMeter(startTime, this.opts.latencyBudgetMs);
    const meter = this.opts.meter ?? new ContextMeter(cachedContextWindow(this.opts.llm.model));
    const compactThreshold = this.opts.compactThreshold ?? 0.8;
    // E6: what each compaction cost, so the caller is told rather than trusting
    // that a run which felt slow did or did not rewrite its own transcript.
    const compactions: CompactionRecord[] = [];
    // E80: every call the gate judged, as it was judged.
    const calls: TurnCall[] = [];
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
    // E34: whether ANYBODY priced this run, which is not the same question as whether it
    // cost zero. Tracked beside the total rather than read off the meter, because the
    // meter is only told about the step calls and the planning call is a model call too.
    let priced = false;
    let deniedCount = 0;
    // E94: replies in a row with no text and no call, and whether any call did real work in this run.
    let emptyReplies = 0;
    let workedThisRun = false;
    // E81: every call that succeeded in this run, in order, which is what can mark a step of the persona's
    // list done; and the one message that puts the list back in front of the model, replaced rather than added.
    const succeeded: string[] = [];
    let taskReminder: ChatMessage | undefined;
    // E83: the route chosen before acting, when this model's scaffold asks for the step. Not `decision`: the
    // loop already has one of those, the completion verdict, and a second would be shadowed by it.
    let turnDecision: Decision | undefined;
    // E84: every question put to a person this run, with the answer when there was one.
    const questions: (PersonQuestion & { answer?: string })[] = [];
    // E85: the files this run left, in the order they were written, and what the runtime made of them at the
    // end. `delivered` is filled once, when a completion is accepted, because that is when the files are final.
    const deliveredHere: Delivered[] = [];
    let delivered: DeliveredVerification | undefined;
    // E86: the rounds this turn opened, and the tasks one already took. A task gets at most one round: the
    // parent cannot mark it done, because only a call that succeeded HERE backs a done and a round's calls
    // happened in the child, so without this the same task would be handed down for the rest of the turn.
    const rounds: RoundTaken[] = [];
    const rounded = new Set<string>();
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
    // The last call that succeeded, across steps, so a success that only repeats it is a stall.
    let lastSucceeded: string | null = null;
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
    // K5: the catalogue is re-read at the START OF A TURN, which is one of the two cut
    // points E6 named and the cheap one. Before this the agent copied the bench once, in
    // its constructor, and never looked again: a permission withdrawn mid-session left the
    // tool on offer for the rest of the agent's life, which is precisely what
    // `mounted.ts` argues must not happen, and a plugin woken by K2 could never arrive.
    //
    // Nothing is re-read between turns other than here, because a tool appearing inside a
    // turn moves the prefix the provider has already cached.
    this.refreshCatalogue();
    // E81: the persona's own task list is offered on every run. A list it never needs costs one declaration;
    // a plan that lives only in the conversation costs the steps a small model loses when it scrolls away.
    // E84: and a way to ask the person for what only they can give, on every run for the same reason.
    const baseTools = [...this.tools, ...outputStoreTools(outputStore), updateTasksTool, askPersonTool];

    // J.2: subset the tools shown to the model to what this task's skills need, so a large
    // catalog does not invite tool-overload. Opt-in: with no skills configured, the full set is
    // used unchanged. Uncategorized tools (memory) stay available; `finish` always does.
    // J.2b: with a subset in force, the model needs a way to say "I need something I was
    // not given" instead of doing the wrong thing with a tool it has. Only offered when a
    // subset exists: with the full catalog there is nothing to find.
    // E21: the subset is chosen ONCE and then held, because it is part of the cached
    // prefix and not part of the turn.
    //
    // The row this comes from was deferred with its condition written down: "when the
    // catalogue is large enough that choosing costs something". E3 met it, since being
    // an MCP client turns six tools into however many each server brings. But the
    // obvious reading, subset per turn, collides with E5: providers cache a PREFIX, and
    // the tool declarations sit in it, so a catalogue that changes between turns
    // invalidates everything behind it. A subset that saves a few hundred prompt tokens
    // per turn while costing a full cache write of the whole prefix is a loss.
    //
    // So the first task decides and the rest of the session lives with it, and the way
    // out when the choice was wrong is `find_tools`, which already exists for exactly
    // this: "I need something I was not given" beats doing the wrong thing with what
    // you have. Callers that keep an agent per turn pass `toolNames` from the session.
    const pinned = this.opts.toolNames;
    // E72: skills no longer choose the catalogue or the guides. Choosing them by counting the
    // words a message shared with each skill activated every skill that shared a word and none
    // that did not, and its tool subset hid `check_page` from the one step written to use it.
    // A persona now loads a skill itself with `use_skill`, and a skill never removes a tool.
    let activeTools =
      pinned === undefined
        ? baseTools
        : // Pinned by the session. `finish` and `find_tools` are added rather than
          // required in the list: a caller pinning a subset should not have to remember
          // the two tools that make a subset survivable, and forgetting them produces a
          // session that cannot end or cannot ask.
          [...baseTools.filter((t) => pinned.includes(t.name) || t.name === FINISH_TOOL), findToolsTool];

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
      // Everything that changes per turn belongs on the far side of everything that does not.
      ...(remembered.trim() ? [{ role: "system" as const, content: remembered }] : []),
      // E20: the confinement of this turn, out of the identity and into the moment.
      { role: "system" as const, content: this.scopeOfTheMoment() },
      ...(this.opts.priorMessages ?? []),
      // V7.A1: environment changes are SYSTEM speech, not the user's words.
      ...(this.opts.envNote ? [{ role: "system" as const, content: this.opts.envNote }] : []),
      { role: "user", content: task },
    ];
    this.lastMessages = messages; // reference; reflects the final state after the run

    // E83: decide before acting, when this model's scaffold asks for it. One call with no tools and one
    // attempt: a model that cannot write the object the first time rarely writes it the second, and the turn
    // goes on without a route rather than stopping. The instruction travels only in this request; what stays
    // in the conversation is the route, as a runtime note after the person's message.
    if (scaffoldFor(this.opts.llm) === "small") {
      const res = await clock.time("model", () =>
        requestToolCall(this.opts.llm, [...messages, { role: "system", content: DECIDE_INSTRUCTION }], [], this.preferFallback),
      );
      tokens += res.usage?.total_tokens ?? 0;
      if (res.usage) priced = true;
      meter.observe(res.usage);
      const read = parseDecision(res.text);
      if (read.ok) {
        turnDecision = read.decision;
        messages.push({
          role: "system",
          content: `[${authorId({ kind: "runtime", mechanism: "decision", reason: "the route the persona chose before acting" })}] ${describeDecision(read.decision)}`,
        });
        bus.emit({ type: "agent-think", text: `[decide] ${read.decision.route}${read.decision.why ? `: ${read.decision.why}` : ""}` });
      } else {
        bus.emit({ type: "agent-think", text: `[decide] no route (${read.error}); going on without one` });
      }
    }

    // J.4c: plan before acting, when asked to. The anchor goes in as system speech so the
    // model is held to what it said it would do; a refused plan stops the run here, before
    // any tool has been called.
    // E83: a persona that decided the request is several steps of work plans it through the same gate.
    const operatorPlans = this.opts.plan?.enabled === true;
    if (operatorPlans || turnDecision?.route === "work") {
      const planning = await runPlanPhase(
        messages,
        {
          ask: async (planMessages) => {
            // No tools offered: this turn is for text, and a model handed tools during
            // planning calls one, which is the acting this phase exists to precede.
            const res = await clock.time("model", () =>
              requestToolCall(this.opts.llm, [...planMessages], [], this.preferFallback),
            );
            tokens += res.usage?.total_tokens ?? 0;
            if (res.usage) priced = true;
            // E34: the planning call is a model call, and it was never shown to the meter,
            // so every cache report this run produced was missing it.
            meter.observe(res.usage);
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
        this.opts.plan ?? {},
      ).catch((error: unknown): PlanPhaseResult => {
        // A planning call that errors ends a run the operator asked to plan, as it always did.
        if (operatorPlans) throw error;
        return { ok: false, reason: `the planning call failed: ${error instanceof Error ? error.message : String(error)}`, attempts: 0 };
      });

      if (!planning.ok && !operatorPlans) {
        // E83: a plan the persona's own route asked for is a help, not a gate the operator set. Measured
        // 2026-09-15: with `command-a-reasoning` the planning call failed and the turn ended failed with 0
        // steps, on requests it handled before the step existed. So when no usable plan comes out (the call
        // fails, the plan cannot be read, or the gate refuses its steps) the turn acts without an anchor and
        // says why, and the gate still judges every call it makes.
        bus.emit({ type: "agent-think", text: `[plan] no usable plan (${planning.reason}); acting without one` });
      } else if (!planning.ok) {
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
          cache: meter.cacheReport(),
          latency: clock.report(),
          compactions,
          calls,
          tasks: taskState.snapshot().subTasks,
          ...(turnDecision === undefined ? {} : { decision: turnDecision }), ...(questions.length === 0 ? {} : { questions }),
          trace: buildTrace(intents, traceNodes),
        };
      }
      if (planning.ok) {
        messages.push({ role: "system", content: planning.anchor });
        // E9: the plan's steps become the intentions a trace is read against, and the
        // tools they declare become the only honest way to attribute a call to one.
        planning.steps.forEach((step, index) => {
          intents.set(index + 1, step.note?.trim() || step.tool);
        });
        for (const [tool, step] of unambiguousSteps(planning.steps)) stepOfTool.set(tool, step);
      }
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
    // E34: the price is ABSENT when nobody reported one, and this is what makes the
    // distinction the seam defends actually reachable. `costOf` has always had two careful
    // branches for "a turn nobody priced and a turn that cost nothing are different facts",
    // and both were dead: the fields were required numbers, so a provider that said nothing
    // was written down as having cost zero, one layer below where anybody could tell.
    const report = (steps: number, stoppedBy: string | null): AgentBudgetReport => ({
      steps,
      ...(priced
        ? {
            tokens,
            costUsd: Number(estimateCostUsd(this.opts.llm.model, tokens).toFixed(4)),
          }
        : {}),
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
         // E88: the provenance, whatever happened to the draft. A skill in a folder with nothing saying who
         // decided it, out of which work, or whether a person approved it, is a method nobody can audit; and a
         // draft the security floor refused is a thing that happened too, so `blocked` is written like the rest.
         //
         // The runtime is the author: the persona wrote the METHOD, and that it became a file under this policy
         // is not something it chose. An entry in its name would be claiming otherwise.
         if (res.ran && !res.write) {
         	// E88: the reflection happened and kept nothing. Written down for `E85`'s reason: a run that reflected
         	// and kept nothing, and a run that never reflected, are different facts that silence renders identical.
         	try {
         		await writingToRecord(p, pathJoin(pathDirname(p), "state.json"), {}, (record) => {
         			record.append(
         				{ kind: "runtime", mechanism: "skill-writer", reason: "the persona was asked what it learned and kept nothing" },
         				{ type: "reflection", reason: res.reason, from: task.replace(/\s+/g, " ").slice(0, 160) },
         			);
         		});
         	} catch {
         		/* provenance is additive; a record that cannot be written never takes down a run */
         	}
         }
         if (res.write) {
         	try {
         		const write = res.write;
         		await writingToRecord(p, pathJoin(pathDirname(p), "state.json"), {}, (record) => {
         			record.append(
         				{ kind: "runtime", mechanism: "skill-writer", reason: "a method the persona abstracted from its own work, and where it landed" },
         				{
         					type: "skill",
         					name: write.name,
         					hash: write.hash,
         					outcome: write.outcome,
         					reason: write.reason,
         					from: task.replace(/\s+/g, " ").slice(0, 160),
         				},
         			);
         		});
         	} catch {
         		/* provenance is additive; a record that cannot be written never takes down a run */
         	}
        }
      } catch {
        /* reflection is additive; never let it take down the run */
      }
    };

    // Run the objective verifier on a candidate completion; returns whether to
    // accept (finish), retry, or stop, the maker≠checker gate.
    const verifyCompletion = async (summary: string): Promise<"accept" | "retry" | "stop"> => {
      // E85: what follows from what the turn LEFT runs first, and runs whether or not the persona declared
      // gates of its own. Deriving it from the deliverables is what makes it possible at all: nobody declares
      // `verification:` today, so hanging this on that switch would ship a row that is off everywhere. It does
      // not decide the turn: a check that fails is written down, and what judges completion is still the
      // persona's own gates below. Saying "it runs" is exactly as much as running it proves.
      const left = deliveredIn(deliveredHere);
      if (left.length > 0) {
        const result = runDerivedChecks(left.map((file) => file.path));
        delivered = result;
        for (const check of result.checks) {
          bus.emit({ type: "verify-result", verifier: `${check.what}: ${check.how}`, pass: check.passed, reason: check.reason ?? "" });
        }
      }
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
        const timing = clock.report();
        bus.emit({
          type: "agent-budget",
          step: step - 1,
          tokens,
          costUsd: Number(estimateCostUsd(this.opts.llm.model, tokens).toFixed(4)),
          wallSeconds: Number(((Date.now() - startTime) / 1000).toFixed(1)),
          latency: {
            modelMs: timing.modelMs,
            gateMs: timing.gateMs,
            toolMs: timing.toolMs,
            unattributedMs: timing.unattributedMs,
            ...(timing.overBudget ? { overBudgetMs: timing.overBudget.worstTurnMs } : {}),
          },
        });
        if (check.shouldStop) {
          bus.emit({ type: "agent-stop-condition", reason: check.stopReason ?? "budget", step: step - 1 });
          const summary = budget.onExhaust === "summarize_and_stop" ? (lastText || `stopped: ${check.stopReason}`) : `stopped: ${check.stopReason}`;
          bus.emit({ type: "agent-finish", summary, steps: step - 1 });
          this.persist(task, "stopped", summary, step - 1);
          return { summary, steps: step - 1, finished: false, budget: report(step - 1, check.stopReason), verification: this.lastVerification, ...(delivered === undefined ? {} : { delivered }), ...(rounds.length === 0 ? {} : { rounds }), cache: meter.cacheReport(), latency: clock.report(), compactions, calls, tasks: taskState.snapshot().subTasks, ...(turnDecision === undefined ? {} : { decision: turnDecision }), ...(questions.length === 0 ? {} : { questions }), trace: buildTrace(intents, traceNodes) };
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
          return { summary, steps: step - 1, finished: false, budget: report(step - 1, "watchdog"), verification: this.lastVerification, ...(delivered === undefined ? {} : { delivered }), ...(rounds.length === 0 ? {} : { rounds }), cache: meter.cacheReport(), latency: clock.report(), compactions, calls, tasks: taskState.snapshot().subTasks, ...(turnDecision === undefined ? {} : { decision: turnDecision }), ...(questions.length === 0 ? {} : { questions }), trace: buildTrace(intents, traceNodes) };
        }

        clock.turnBegan();
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
        // E86: a long job in rounds of fresh context, decided BEFORE the compaction below rather than after.
        //
        // The two ask the same question, whether this context is still a good place to work, and the round has
        // to win: compacting rewrites the transcript, and a rewritten transcript is the damage a fresh context
        // exists to avoid. A round needs a task, and the persona's own list is the only place one comes from,
        // so a run that keeps no list never rounds and compaction goes on doing exactly what it did.
        if (roundsOn(this.opts.llm) && rounds.length < MAX_ROUNDS_PER_TURN) {
          const state = taskState.snapshot();
          const opening = nextRound({
            tasks: state.subTasks,
            contextPct: meter.pct,
            contextThreshold: compactThreshold,
            rounded,
            taken: rounds.length,
          });
          // The persona's OWN delegation, taken from the catalogue it was offered rather than built here. A
          // read-only persona is never offered it and a depth already spent refuses, and in both cases there
          // are no rounds and the turn goes on as before, which is what makes this additive.
          const handDown = opening ? activeTools.find((t) => t.name === DELEGATE_TOOL) : undefined;
          if (opening && handDown) {
            // What this round is about, in one phrase, for the record and for the line the parent reads back.
            // A round with no listed task is not a corner case: measured on 2026-09-16, neither model wrote a
            // list at all on a job of six pieces, so this is what a filling context hands down.
            const what = opening.task?.text ?? "what is left of the job";
            if (opening.task !== undefined) rounded.add(opening.task.id);
            const left = deliveredIn(deliveredHere);
            const brief = briefFor({
              goal: state.goal,
              ...(opening.task === undefined ? {} : { task: opening.task }),
              tasks: state.subTasks,
              // Checked now rather than read off the close: what a fresh context needs is what is true when it
              // starts, and the close has not happened yet.
              delivered: left.length > 0 ? runDerivedChecks(left.map((file) => file.path)) : { checks: [], unverified: [] },
              errors: state.recentErrors,
            });
            bus.emit({ type: "agent-think", text: `[round] ${opening.because}: ${what}` });
            // Through the interceptor like any other call, so the round is sealed into the same forensic log as
            // the work around it. Nothing is skipped by the loop making this call itself: delegation's gate
            // allows unconditionally, and every call the child makes faces its own gate inside the child's run.
            // Not pushed into `calls`, which is every call the gate judged FOR THE MODEL: the model did not
            // make this one, and it has a record entry of its own that says who did.
            const ran = await clock.time("tool", () =>
              interceptor.run(handDown, { id: `round-${rounds.length + 1}`, name: DELEGATE_TOOL, args: { task: brief } }),
            );
            const accepted: Accepted<string> = accept(ran.output, contextTaint);
            contextTaint = accepted.taint;
            rounds.push({ task: what, because: opening.because, reply: accepted.value.slice(0, ROUND_REPLY_CHARS) });
            // Only the answer comes back, and it comes back as the runtime speaking. The sub-task's transcript
            // never reached here (`subTaskSession` drops the parent's and keeps its own), and labelling this as
            // the person would be the forgery the author invariant exists to prevent.
            messages.push({
              role: "system",
              content:
                `[${authorId({ kind: "runtime", mechanism: "round", reason: "one task of the list worked in a context with none of this one's history" })}] ` +
                `A round worked "${what}" in a fresh context. All that comes back is its answer:\n${accepted.value}`,
            });
          }
        }

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
            // K5: the other named cut point. The transcript has just been rewritten, so
            // the cached prefix is already spent and a tool arriving now costs nothing
            // extra. This is why the row asks for a COMPACTION boundary rather than any
            // convenient moment.
            this.refreshCatalogue();
            // A compaction with no plan cannot happen: `compactMessages` builds one on
            // the branch that sets `compacted`. The fallback is an empty plan carrying
            // the numbers rather than a cast, so a future branch that compacts without
            // saying what it moved shows up in the record as a compaction that named
            // nothing, instead of crashing the turn it was supposed to be describing.
            const plan = c.plan ?? { kept: [], pruned: [], summarised: [], before, after: meter.used };
            compactions.push({ cut, step, removed: c.removed ?? 0, before, after: meter.used, plan });
            // E18: and against the session, which outlives this run and is what /context reads.
            meter.compacted(before, meter.used);
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
        const res = await clock.time("model", () =>
          requestToolCall(
            { ...this.opts.llm, onDelta: (text) => bus.emit({ type: "agent-delta", text }) },
            messages,
            activeTools,
            this.preferFallback,
          ),
        );
        if (res.usedFallback) this.preferFallback = true;
        tokens += res.usage?.total_tokens ?? 0;
        if (res.usage) priced = true;
        meter.observe(res.usage);
        if (!res.usage) meter.estimate(messages);
        bus.emit({ type: "context-meter", used: meter.used, limit: meter.limit, pct: Number(meter.pct.toFixed(3)) });
        if (res.text) {
          lastText = res.text;
          bus.emit({ type: "agent-think", text: res.text });
        }

        // E94: a reply with no text and no call is not an answer.
        //
        // It was taken as one. Measured on 2026-09-15 against `command-a-plus-05-2026`: after reading its
        // reference and loading two skills, the model ended with `finish_reason: stop`, 1 226 characters of
        // reasoning and no text, and the turn closed answered with nothing for the person. Told once, with
        // the reason, it writes the answer. Nothing empty goes into the conversation on the way: some
        // providers refuse an empty message, and it would teach the model that silence is a reply.
        const saidNothing = res.toolCalls.length === 0 && !(res.text ?? "").trim();
        if (!saidNothing) emptyReplies = 0;
        if (saidNothing) {
          emptyReplies += 1;
          if (emptyReplies === 1) {
            const why =
              res.finish === "length"
                ? "it was cut at the length limit before any text"
                : res.reasoned
                  ? "only your reasoning came back, and the person never sees your reasoning"
                  : "nothing came back";
            messages.push({
              role: "system",
              content:
                `[${authorId({ kind: "runtime", mechanism: "empty-reply", reason: "the model returned no text and no action" })}] ` +
                `Your last reply had no text for the person and no action: ${why}. ` +
                "Reply to the person now, in plain words, with what you did and what you found, or continue with a tool call.",
            });
            bus.emit({ type: "agent-think", text: "[empty-reply] the model returned no text and no action; asking once more" });
            continue;
          }
          if (!workedThisRun) {
            // Twice, and nothing was done before it. The closed set's word is `empty`, not answered.
            bus.emit({ type: "agent-finish", summary: "", steps: step });
            this.persist(task, "stopped", "the model returned nothing", step);
            return { summary: "", steps: step, finished: false, budget: report(step, "empty"), verification: this.lastVerification, ...(delivered === undefined ? {} : { delivered }), ...(rounds.length === 0 ? {} : { rounds }), cache: meter.cacheReport(), latency: clock.report(), compactions, calls, tasks: taskState.snapshot().subTasks, ...(turnDecision === undefined ? {} : { decision: turnDecision }), ...(questions.length === 0 ? {} : { questions }), trace: buildTrace(intents, traceNodes) };
          }
          // Twice, after real work: the work stands and the turn ends without words, through the ordinary
          // completion below, so a declared verification still judges it.
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
            return { summary: res.text || "", steps: step, finished: true, budget: report(step, "goal_met"), verification: this.lastVerification, ...(delivered === undefined ? {} : { delivered }), ...(rounds.length === 0 ? {} : { rounds }), cache: meter.cacheReport(), latency: clock.report(), compactions, calls, tasks: taskState.snapshot().subTasks, ...(turnDecision === undefined ? {} : { decision: turnDecision }), ...(questions.length === 0 ? {} : { questions }), trace: buildTrace(intents, traceNodes) };
          }
          if (decision === "stop") {
            bus.emit({ type: "agent-finish", summary: "verification failed", steps: step });
            this.persist(task, "verification_failed", "verification failed", step);
            return { summary: "verification failed", steps: step, finished: false, budget: report(step, "verification_failed"), verification: this.lastVerification, ...(delivered === undefined ? {} : { delivered }), ...(rounds.length === 0 ? {} : { rounds }), cache: meter.cacheReport(), latency: clock.report(), compactions, calls, tasks: taskState.snapshot().subTasks, ...(turnDecision === undefined ? {} : { decision: turnDecision }), ...(questions.length === 0 ? {} : { questions }), trace: buildTrace(intents, traceNodes) };
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
        // E80: an allowed call as the record will write it. What of the persona's material it used is
        // asked only when it succeeded: a read that failed used nothing.
        const allowed = (call: ToolCall, ok: boolean, reason?: string): TurnCall => {
          const used = ok
            ? materialUsed({ tool: call.name, args: call.args ?? {}, policy: this.policy, personaPath: this.opts.personaPath })
            : undefined;
          // E85: what the call LEFT, asked in the same place and under the same condition as what it used. The
          // moment is taken here, when the call has returned, because that is the moment the evidence is about.
          if (ok) {
            const left = deliveredBy({ tool: call.name, args: call.args ?? {}, policy: this.policy, at: Date.now() });
            if (left !== undefined) deliveredHere.push(left);
          }
          return {
            callId: call.id,
            tool: call.name,
            verdict: "allowed",
            step,
            ...(reason === undefined ? {} : { reason }),
            ...(used === undefined ? {} : { used }),
          };
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

          // E81: the persona's own task list. Handled here for the reason `find_tools` is: what marks a step
          // done is a call that succeeded in this run, and only the loop has seen those. It is not work, so it
          // neither backs a step nor counts as progress.
          if (call.name === UPDATE_TASKS_TOOL) {
            const update = applyTaskUpdate(taskState, call.args ?? {}, succeeded);
            if (update.ok) bus.emit({ type: "task-list", tasks: taskState.snapshot().subTasks });
            bus.emit({ type: "tool-result", tool: call.name, ok: update.ok, output: update.reply });
            messages.push({ role: "tool", tool_call_id: call.id, name: call.name, content: update.reply });
            continue;
          }

          // E84: a question to the person. Handled here because only the run knows whether anybody is there.
          if (call.name === ASK_PERSON_TOOL) {
            const read = readQuestion(call.args ?? {});
            if (!read.ok) {
              bus.emit({ type: "tool-result", tool: call.name, ok: false, output: read.reply });
              messages.push({ role: "tool", tool_call_id: call.id, name: call.name, content: read.reply });
              continue;
            }
            if (this.opts.onQuestion) {
              const answer = (await this.opts.onQuestion(read.question)).trim();
              questions.push({ ...read.question, answer });
              const reply = answer
                ? `The person answered: ${answer}`
                : "The person gave no answer. Do not invent one: go on with what does not depend on it, or say what you still need.";
              bus.emit({ type: "tool-result", tool: call.name, ok: true, output: reply });
              messages.push({ role: "tool", tool_call_id: call.id, name: call.name, content: reply });
              continue;
            }
            // Nobody can answer here. P10 of E77: the turn stops at the question, written down, and nothing is
            // guessed. Every call of this batch gets its result first, because a transcript with a call and no
            // result is one the next request cannot send.
            questions.push({ ...read.question });
            const stopsHere = "Nobody can answer here right now, so this turn stops at your question, written down for whoever picks the work up.";
            bus.emit({ type: "tool-result", tool: call.name, ok: true, output: stopsHere });
            messages.push({ role: "tool", tool_call_id: call.id, name: call.name, content: stopsHere });
            for (const later of res.toolCalls.slice(res.toolCalls.indexOf(call) + 1)) {
              messages.push({ role: "tool", tool_call_id: later.id, name: later.name, content: "not run: the turn stopped at a question nobody here can answer" });
            }
            return {
              summary: `Waiting for an answer before going on:\n${renderQuestion(read.question)}`,
              steps: step,
              finished: false,
              budget: report(step, "question"),
              verification: this.lastVerification, ...(delivered === undefined ? {} : { delivered }), ...(rounds.length === 0 ? {} : { rounds }),
              cache: meter.cacheReport(),
              latency: clock.report(),
              compactions,
              calls,
              tasks: taskState.snapshot().subTasks,
              ...(turnDecision === undefined ? {} : { decision: turnDecision }),
              questions,
              trace: buildTrace(intents, traceNodes),
            };
          }

          const tool = activeTools.find((t) => t.name === call.name) ?? toolByName(call.name);
          if (!tool) {
            errorCount++;
            noteFail(call);
            messages.push({ role: "tool", tool_call_id: call.id, name: call.name, content: `error: unknown tool '${call.name}'` });
            continue;
          }

          // A call that does not match its tool's schema goes back to the model as an error it
          // can fix, before anything judges it. `validateToolArgs` said it ran before the gate
          // and nothing called it: found 2026-09-11 in a real service run, where an `edit_file`
          // with no `path` reached the write gate as `undefined`, the gate threw, and the whole
          // step died as "agent error" instead of the model hearing what it got wrong.
          // An argument too many is left alone, as it always was: the tool ignores it, and turning
          // it into an error would cost a retry for a call that works.
          // A call the model never finished. Running it writes a file whose tail is missing and
          // then answers "ok", which is the worst of both: the work is wrong AND the model is told
          // it succeeded, so it repeats the same cut call. Measured 2026-09-11: seven identical
          // truncated writes of the same half-file before the loop breaker ended the turn. Saying
          // it plainly is what lets a model do the one thing that works, send it in pieces.
          if (call.truncated) {
            errorCount++;
            noteFail(call);
            const cut = `error: this call arrived cut off, so it was not run: the arguments for ${call.name} ended in the middle. Your reply hit its length limit. Send it again in smaller pieces: write a first part, then append the rest with another call.`;
            bus.emit({ type: "tool-result", tool: call.name, ok: false, output: cut });
            messages.push({ role: "tool", tool_call_id: call.id, name: call.name, content: cut });
            continue;
          }

          const argProblems = validateToolArgs(tool, call.args ?? {}).filter((p) => !p.startsWith("unknown arg"));
          if (argProblems.length > 0) {
            errorCount++;
            noteFail(call);
            bus.emit({ type: "tool-result", tool: call.name, ok: false, output: argProblems.join("; ") });
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              name: call.name,
              content: `error: this call does not match ${call.name}'s arguments: ${argProblems.join("; ")}. Call it again with them.`,
            });
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
              calls.push({ callId: call.id, tool: call.name, verdict: "denied", reason: "blocked by PreToolUse hook", step });
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
          // E17: the gate is timed as ONE span covering the tool's own verdict and the
          // waterfall, because that is what a call waits for before anything runs.
          const verdict = clock.sync("gate", () => tool.gate(call.args, this.policy));
          const argsText = JSON.stringify(call.args ?? {});
          const decided = clock.sync("gate", () => runGuards(
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
              // K6: what the capability DECLARED, plus what the runtime can infer. The
              // union and never one or the other: a plugin is not in the inference table
              // and never will be, so without the declaration `github:create_issue`
              // weighs as nothing at all; and a declaration that could REPLACE the
              // inference would let a capability classify itself down, which is the one
              // place the subject of a measurement supplies its own input.
              actionClasses: [
                ...new Set([
                  ...(tool?.envelope ?? []),
                  ...actionClassesFor(call.name, argsText),
                ]),
              ].sort(),
              turn: call.id,
              // E59: where "inside" is, so the compiled policy can let a write to the
              // project through to the approval axis instead of refusing it as if it
              // left. Our tools resolve a relative path against this same root.
              workspaceRoot: this.policy.workspaceRoot,
            }),
          ));

          // K.04: tighten the cascade's verdict with the HITL risk matrix (posture × taint ×
          // reversibility × sensitivity). Consent can only make it STRICTER: a destructive action
          // while the context is malicious-tainted is denied even if the gate would allow it.
          const consented = tightenVerdict(decided.verdict, {
            klass: verdict.class,
            sandbox: this.policy.sandbox as SandboxPosture,
            taint: contextTaint,
            // E61: the approval posture for THIS call's class, so `never` silences an ordinary
            // write the way full access does, and a per-category override that keeps network
            // asking still keeps it asking.
            approval: effectiveApproval(this.policy, verdict.class),
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
            calls.push({ callId: call.id, tool: call.name, verdict: "denied", reason: decisionReason, step });
            output = `denied by policy: ${decisionReason}`;
          } else if (consented.decision === "ask") {
            // C6b: who refused, in their own words when they gave any. Absent a
            // handler there is nobody to ask at all, which is a different sentence
            // from somebody saying no, and the record now tells them apart.
            const answered: ApprovalAnswer = this.opts.onApproval
              ? await this.opts.onApproval(call, verdict)
              : { decision: "deny", reason: "this run has nobody to ask, so an approval is a refusal" };
            const decision = typeof answered === "string" ? answered : answered.decision;
            const refusal =
              typeof answered === "string"
                ? "the approval handler refused it"
                : answered.reason;
            if (decision === "deny") {
              deniedCount++;
              noteFail(call);
              interceptor.recordBlocked(call.name, "ask", refusal);
              calls.push({ callId: call.id, tool: call.name, verdict: "denied", reason: refusal, step });
              output = `denied: ${refusal}`;
            } else {
              if (decision === "always") this.policy.allow.push(escapeRegExp(firstArg(call)));
              const r = await clock.time("tool", () => interceptor.run(tool, call));
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
              if (r.ok) { producedWork = true; callProduced = true; workedThisRun = true; succeeded.push(call.id); }
              else { errorCount++; noteFail(call); }
              calls.push(allowed(call, r.ok, "approved when asked"));
            }
          } else {
            const r = await clock.time("tool", () => interceptor.run(tool, call));
            const accepted: Accepted<string> = accept(r.output, contextTaint);
            output = accepted.value;
            contextTaint = accepted.taint;
            if (r.ok) { producedWork = true; callProduced = true; workedThisRun = true; succeeded.push(call.id); }
            else { errorCount++; noteFail(call); }
            calls.push(allowed(call, r.ok));
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
          // The same call succeeding again right after itself changed nothing, so it is not
          // progress. Found 2026-09-11 in the E52 bench: a model rewrote the same file with the
          // same content every 45 seconds for fifteen minutes, and every write counted as work,
          // so the breaker never saw a stall. Counted as a stall and not as a failure, because it
          // did not fail: the breaker's own words, "no progress", are what happened.
          const signature = toolSignature(call.name, call.args);
          const sameAsLast = callProduced && signature === lastSucceeded;
          if (callProduced) lastSucceeded = signature;
          breaker.record({
            producedWork: callProduced && !sameAsLast,
            failingSignature: callProduced ? null : signature,
          });
        }

        stepProgress = producedWork ? 1 : 0;

        // J.4: loop breaker. A finish this step short-circuits below, so only assess when the
        // run is actually continuing.
        // E81: the list back at the end of what the model reads, after every batch of calls, so a long
        // conversation does not bury it. One message, replaced each time rather than added, so it never grows
        // the context it protects, and it moves only the tail of the cached prefix.
        const taskList = taskState.renderTaskList();
        if (taskList) {
          const at = taskReminder ? messages.indexOf(taskReminder) : -1;
          if (at >= 0) messages.splice(at, 1);
          taskReminder = {
            role: "system",
            content: `[${authorId({ kind: "runtime", mechanism: "task-list", reason: "the persona's own list, put back after a batch of calls" })}] ${taskList}`,
          };
          messages.push(taskReminder);
        }

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
            return { summary, steps: step, finished: false, budget: report(step, "loop_breaker"), verification: this.lastVerification, ...(delivered === undefined ? {} : { delivered }), ...(rounds.length === 0 ? {} : { rounds }), cache: meter.cacheReport(), latency: clock.report(), compactions, calls, tasks: taskState.snapshot().subTasks, ...(turnDecision === undefined ? {} : { decision: turnDecision }), ...(questions.length === 0 ? {} : { questions }), trace: buildTrace(intents, traceNodes) };
          }
        }

        if (finishedThisStep) {
          const decision = await verifyCompletion(finishedThisStep.summary);
          if (decision === "accept") {
            bus.emit({ type: "agent-finish", summary: finishedThisStep.summary, steps: step });
            this.persist(task, "success", finishedThisStep.summary, step);
            await maybePostmortem("success", step);
            return { summary: finishedThisStep.summary, steps: step, finished: true, budget: report(step, "goal_met"), verification: this.lastVerification, ...(delivered === undefined ? {} : { delivered }), ...(rounds.length === 0 ? {} : { rounds }), cache: meter.cacheReport(), latency: clock.report(), compactions, calls, tasks: taskState.snapshot().subTasks, ...(turnDecision === undefined ? {} : { decision: turnDecision }), ...(questions.length === 0 ? {} : { questions }), trace: buildTrace(intents, traceNodes) };
          }
          if (decision === "stop") {
            bus.emit({ type: "agent-finish", summary: "verification failed", steps: step });
            this.persist(task, "verification_failed", "verification failed", step);
            return { summary: "verification failed", steps: step, finished: false, budget: report(step, "verification_failed"), verification: this.lastVerification, ...(delivered === undefined ? {} : { delivered }), ...(rounds.length === 0 ? {} : { rounds }), cache: meter.cacheReport(), latency: clock.report(), compactions, calls, tasks: taskState.snapshot().subTasks, ...(turnDecision === undefined ? {} : { decision: turnDecision }), ...(questions.length === 0 ? {} : { questions }), trace: buildTrace(intents, traceNodes) };
          }
          // retry: loop continues; the failure note is already in messages.
        }
      }

      bus.emit({ type: "agent-finish", summary: `stopped at hard ceiling`, steps: HARD_CEIL });
      this.persist(task, "stopped", "stopped at hard ceiling", HARD_CEIL);
      return { summary: `stopped at hard ceiling`, steps: HARD_CEIL, finished: false, budget: report(HARD_CEIL, "hard_ceiling"), verification: this.lastVerification, ...(delivered === undefined ? {} : { delivered }), ...(rounds.length === 0 ? {} : { rounds }), cache: meter.cacheReport(), latency: clock.report(), compactions, calls, tasks: taskState.snapshot().subTasks, ...(turnDecision === undefined ? {} : { decision: turnDecision }), ...(questions.length === 0 ? {} : { questions }), trace: buildTrace(intents, traceNodes) };
    } catch (err) {
      bus.emit({ type: "agent-error", message: (err as Error).message });
      this.persist(task, "error", `agent error: ${(err as Error).message}`, 0);
      return { summary: `agent error: ${(err as Error).message}`, steps: 0, finished: false, budget: report(0, "error"), verification: this.lastVerification, ...(delivered === undefined ? {} : { delivered }), ...(rounds.length === 0 ? {} : { rounds }), cache: meter.cacheReport(), latency: clock.report(), compactions, calls, tasks: taskState.snapshot().subTasks, ...(turnDecision === undefined ? {} : { decision: turnDecision }), ...(questions.length === 0 ? {} : { questions }), trace: buildTrace(intents, traceNodes) };
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