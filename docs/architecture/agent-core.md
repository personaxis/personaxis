---
title: Agent core architecture
version: 1.0.0
date: 2026-07-21
status: draft
---

# Agent core architecture

How the Personaxis agent reasons, acts, learns, and stays safe over long-horizon tasks. This
is the design contract for the production agent loop. It names what already exists in
`packages/core` and what the V11 program adds, so the two never drift.

Design stance: the agent's behavior is **derived from the persona**, not hardcoded. Reasoning
depth reads `cognition.uncertainty_policy`; refusal reads `self_regulation.hard_limits`;
learning reads `memory` and `improvement_policy`. The code is the mechanism; the persona is
the policy.

## 1. Tools: one typed source, no drift

**Today.** `core/src/tools/registry.ts` holds a hand-written `TOOLS[]` array. A prior deliberate
decision (**FR.7**, documented in `registry.ts`) makes the JSON Schema the *single* schema source
and rejects a parallel Zod declaration; schemas are flat by design. That already removes
schema↔schema drift. The gap it leaves: handlers read `args` as an untyped
`Record<string, unknown>` (e.g. `str(a, "path")`), so nothing at compile time ties the handler's
argument access to the schema it declared.

**Target (honors FR.7, no Zod, no new runtime dependency).**
`defineTool({ name, description, category, danger, parameters, isReadOnly, isConcurrencySafe,
gate, execute })` keeps the JSON Schema as the single source and derives the handler's `args`
**type** from that schema with a local `InferArgs<Schema>` mapper for flat schemas (only primitive
props, which FR.7 guarantees). So the schema still drives runtime validation
(`validateToolArgs`) *and* now the handler's compile-time types, from one declaration. The catalog
is assembled from `tools/builtin/*` (one file per tool), not a central array; adding a capability
is one isolated file. MCP tools enter the same registry through an adapter. Namespacing by
category (`fs`, `shell`, `persona`, `net`, `mcp`).

**Why this and not Zod.** Reversing FR.7 to introduce Zod would reintroduce exactly the parallel
declaration that decision removed, and add a runtime dependency to `core`. Deriving the handler
type from the existing JSON Schema achieves the same goal (no drift, compile-time + runtime
safety, modular registration) while respecting the prior reasoning and staying dependency-free.
Every tool is registered *behind the interceptor* (security module 03): there is no path from the
model to the OS that skips the pipeline.

## 2. Skills drive tool selection, dynamically

**Today.** `core/src/skill-lifecycle.ts` scores skills for a task (`recommend()` =
capabilityMatch × trust × successRate) but nothing injects them, and the agent always starts
with the full tool catalog.

**Target algorithm, at task start.**
1. Derive task capabilities; call `recommend(task)`.
2. Select the top-k skills over a score threshold; inject *their* methodology (`.md`) into the
   system prompt as the active playbook (hot tier). Not every skill, only the relevant ones.
3. Each skill declares `allowed_tools`; the agent starts with the **subset** those skills need
   plus the base tools, not the whole catalog (tool-subsetting).
4. If mid-task the model needs a capability outside the subset, it expands on demand via a
   `find_tools` tool (the deferred-tool pattern).

**Why.** Fewer tools in the prompt means less tool hallucination and fewer tokens (the
"tool-overload" failure). The skill anchors *method*, cutting blind exploration. Subsetting with
on-demand expansion keeps decision quality high as the catalog grows. New module:
`core/src/skill-activation.ts`, invoked in `agent.ts` before the loop.

## 3. Self-evolution: a post-mortem that writes skills

**Today.** `core/src/self-evolution.ts` proposes and verifies edits to the *spec*; the skill
ledger records outcomes but nothing writes skills.

**Target loop (autonomous only when `improvement_policy = autonomous`).**
1. On closing a hard task (multi-step, failure-then-success, or low initial confidence), run a
   post-mortem: the model receives the transcript + result and extracts the lesson (what failed,
   what worked, the winning sequence).
2. Classify the destination: (a) a new skill `.md` with the abstracted method, (b) a refinement
   (diff) of an existing skill, (c) a memory preference/fact, (d) a spec self-edit proposal.
3. For skills: generate the `.md`, run it through `scanForInjection` + a danger review (a
   self-written skill is code that will later run: **security first, in every posture** — a
   dangerous body is refused even under `autonomous`), and only then through the governance gate
   (block if `locked`, queue to `skills/pending/` if `suggesting`, write to `skills/` if
   `autonomous`).
4. Record a new skill in the ledger with `register` (its birth; `promote` is reserved for a
   version superseding an incumbent, `skill-lifecycle.ts`) plus provenance. The next similar task
   activates it, closing the loop with section 2.

**Why.** This is the Voyager/Reflexion pattern: an auto-generated skill library plus
self-reflection. The agent improves without a human by accumulating reusable *method*, not just
episodic memory. Review + governance stop it from poisoning itself.

**Build status (2026-07-22): shipped.** `core/src/skill-writer.ts` (`renderSkill` deterministic
so the content hash is stable, `safeSkillName` cuts path-traversal from an LLM-chosen name,
`writeSelfSkill` = security floor → governance) and `core/src/postmortem.ts` (`shouldRunPostmortem`
pure heuristic + `runPostmortem` with an injected `extract` LLM caller). `skill-review.ts` grew an
in-memory `reviewSkillContent` so a draft is vetted before it touches disk. Wired opt-in into
`agent.ts` via `AgentOptions.postmortem`, fired best-effort at both success points; the extractor is
the host's to inject, so a persona without it never reflects. Tested (skill-writer + postmortem) and
dogfooded on disk across all four modes. Scope note: the shipped destination is (a), a new skill;
routing to (b) refinement, (c) memory, (d) spec self-edit is a follow-up on the same seam.

## 4. Reasoning: plan first, re-evaluate, and never loop

**Today.** `core/src/agent.ts` is a reactive ReAct loop: request tool, execute, verify at the
end, retry on failure. There is no explicit plan and no repetition breaker.

**Target.**
1. **Plan phase (before acting).** The model produces an explicit plan: steps, expected tools,
   and the security risk of each step, evaluated against the sandbox and hard limits *before*
   touching anything. A plan that violates a hard limit is rejected without executing.
2. **Re-evaluation.** After every tool result, update the plan: did the result change the path,
   is the next step still valid. Light Tree-of-Thought only under uncertainty: when confidence
   drops or a step fails, branch an alternative instead of repeating.
3. **Loop breaker.** A detector for repetition (same tool + near-identical args failing N times)
   or no progress over M steps forces a strategy change or a stop with a diagnosis.
4. **Thinking budget.** Plan and critique are one cheap turn each, bounded; ToT only when
   uncertain, to keep cost down.

**Why.** Plan-first plus re-evaluation reduces wrong actions and the cost of undoing them; the
breaker kills the classic failure (an infinite loop on a broken tool); selective ToT controls
cost. Maps to `cognition.uncertainty_policy` (abstain/disclose) and metacognition. New modules:
`core/src/planner.ts`, `core/src/loop-breaker.ts`; the plan's risk gate reuses
`verification.ts`.

## 5. Security

The security architecture is specified separately and normatively, in documents that are
not published yet. The agent core consumes it: every tool call passes the interceptor,
runs under OS isolation, and any policy violation aborts the process asynchronously. This
section says what the core relies on, not how the isolation is built.

## 6. Context: a task state that outlives the transcript

**Today.** `core/src/context.ts` auto-compacts at 0.8 with a flat LLM summary; a
`ContextMeter` tracks fill.

**Target.**
1. **Structured compaction.** Preserve by section (objective, current plan, decisions, files
   touched, task status, recent errors) and discard noise; the global task state lives in an
   object that survives compaction, independent of the message history.
2. **Tool-output offloading.** Large outputs (build logs, listings) are stored outside the
   context and referenced by handle; the model pulls the relevant slice on demand. `MAX_OUTPUT`
   already truncates; this makes it recoverable.
3. **Auto-correction.** A tool returning an error or unexpected shape triggers `tool-repair.ts`
   and, if it persists, the section-4 breaker.
4. **Token economy.** Prompt cache alignment (hot/cold tiers, already in the compiled doc), tool
   subsetting (section 2), and compaction with headroom (already).

**Why.** A global state outside the history is what prevents degradation as the transcript
grows: the model reasons over a compact state, not over 200 messages. Offloading cuts the cost
of logs; tool-repair + breaker give resilience. New modules: `core/src/task-state.ts`,
`core/src/tool-output-store.ts`; structured compaction extends `context.ts`.

**Build status (2026-07-22): shipped (1, 2), standing (3, 4).** `core/src/task-state.ts`
(`TaskStateTracker`, pure and bounded so it can never bloat the context it protects; `render()`
is the block that survives compaction) and `core/src/tool-output-store.ts` (`ToolOutputStore`
offloads a large output to a handle `out-N` and recovers it by `slice`/`grep`; `outputStoreTools`
exposes `read_output`/`grep_output`, closured over the per-run store like `memoryTools`).
`context.ts` gained `compactMessages({ pinned })`: the task state is pinned as system speech ahead
of the summary, so the goal + plan are authoritative rather than at the summarizer's mercy. Wired
into `agent.ts` per run (store + tracker, offload at the tool-output push, `pinned` on compaction),
which also fixed per-run tool resolution (`activeTools.find(...) ?? toolByName(...)` — the old
global-only lookup could not find a per-run tool the model was shown). Dogfooded: a 54,912-char /
4,000-line log becomes 981 chars in context, and a buried error line is recovered via
`grep_output` (truncation would have lost it). Standing: auto-correction (3) already exists via
`tool-repair.ts` + the section-4 breaker; structured-by-section compaction (1) is partial (the
summarizer already emits section headers; the pin carries the load-bearing state).

**Build status (2026-09-15): the persona writes its own list.** Until then only the loop wrote
the task state (files touched, recent errors), so a run with several steps kept its plan in the
conversation, where it scrolls away, and small open models lose steps exactly there. The persona
now has `update_tasks` (`core/src/tools/update-tasks.ts`): it sends its whole list each time, every
step `pending`, `in_progress`, `done` or `blocked`. The loop handles the call, because a step counts
as done only when a call that succeeded in this run backs it, and only the loop has seen those
(`TaskStateTracker.replaceTasks`). One call backs one step. A step marked done with nothing behind it
is kept as *said done* and shown as `[?]`, to the model and to the person: never silently accepted,
and never refused, since refusing teaches a model to stop reporting. After every batch of calls the
list goes back to the end of what the model reads, as one message replaced rather than added, so it
never grows the context it protects. The TUI shows each revision on one line, and the persona's
record keeps the list the turn ended with, as a `tasks` entry written by the runtime, because
`verified` is its judgement and not the persona's words. A session that pins a tool subset reaches
the list through `find_tools`, like any other tool it did not pin.

**Build status (2026-09-15): deciding before acting, for the models that need it.** A model can be
given a *scaffold* (`core/src/run/model-seam.ts`): `standard`, the loop as it is and the default, or
`small`, which adds one short step before the loop. The step is a call with no tools that asks for a
single JSON object naming the route and why: `answer`, `ask`, `consult` (read its own references or
examples first), `skills`, `delegate` or `work` (`core/src/run/decide.ts`). The persona's index is
already in the prefix, so the step adds a question and not a context. The route comes back as a
runtime note after the person's message and takes no tool away: a guide the model can argue with,
not a cage. `work` also goes through the planning gate that already existed (`runPlanPhase`), which
checks the plan against the persona's limits before any tool runs. That plan is a help the
persona's own route asked for, not a gate an operator set, so when none comes out usable (the call
fails, the plan cannot be read, or its steps are refused) the turn acts without an anchor and says
why, and the gate still judges each call. A run an operator configured to plan keeps the old rule:
no runnable plan, no run. A reply that cannot be read
leaves the turn without a route, said on the activity line, rather than guessed. The record keeps a
`decision` entry in the persona's name, because the route and the reason are its model's words; a
turn on `standard` has none, since reading a decision into a first call would be inventing one. The
scaffold comes from the model's own settings first, then the destination table (`scaffoldFor` in
`core/src/run/destinations.ts`), then `standard`. The table declares no model yet: a model is
declared `small` only after the bench shows the step helps it. A request that offers no tools now
carries no `tools` and no `tool_choice`, because HuggingFace's router answers HTTP 400 to an empty
list with a choice, and that used to send both this step and the planning call into the ReAct
fallback. And an error on such a request is reported as it is rather than sent to that fallback,
which exists for endpoints that cannot take tools and has nothing to offer a request without them.

## 7. Gaps proposed beyond the six pillars

- **Continuous evaluation.** `packages/evals` measures success/cost/steps by task type; wire it
  to the post-mortem so learning triggers on measured *regression*, not only heuristics.
- **Causal traces.** `trace.ts` exists; expose the plan→tools→verification trace as the auditable
  record of each task (evidence for the attestation SaaS).
- **Multi-agent delegation.** The spec already addresses `@sub-personas`; delegate sub-tasks to
  specialized subs with their own budget, coordinated by `blackboard.ts`. Future pillar.
- **Reproducibility.** Seed + a decision log to replay a run (debugging and the research report).

## Build order

Interleaved rather than layered: the low-risk, high-value base (typed tools, plan+breaker,
security enforcement base) ships first; skills→tools, the post-mortem loop, and structured
context follow after the Command Center. The order is a judgement about which failures are
cheapest to discover early, not a dependency graph.
