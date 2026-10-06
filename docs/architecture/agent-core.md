# Agent core

How a persona's agent loop reasons, acts, remembers and stops, in `packages/core`. The agent's
behavior comes from the persona: reasoning depth reads `cognition.uncertainty_policy`, refusal reads
`self_regulation.hard_limits`, learning reads `memory` and `improvement_policy`. The code is the
mechanism and the persona is the policy.

## Tools

Each tool is one file in `core/src/tools/builtin/`, declared with `defineTool` (`tools/define.ts`):
name, description, category, danger, JSON Schema `parameters`, read-only and concurrency flags, a
gate and `execute`. The JSON Schema is the single schema source, so there is no parallel Zod
declaration, and `validateToolArgs` checks arguments against it at run time. MCP tools enter the same
registry through an adapter (`tools/mcp-adapter.ts`). Every tool is registered behind the tool-call
gate, so no path from the model to the operating system skips it.

## Skills and tool selection

The persona does not get a skill picked for it. A selector that scored a message against each
skill's name and description was measured on 2026-09-13 and retired: "game" activated all three of a
game designer's skills, "a kitten crossing the street" activated none, and the tool subset that came
with them hid `check_page` from the one step written to use it.

Instead the persona reads its skills in the work map and loads one by name with `use_skill`
(`tools/use-skill.ts`). Loading is a gated call, so it is also the trace of which skill was used in
which turn. Tools outside the starting set are reached with `find_tools` (`tools/find-tools.ts`):
the model searches, gets names and descriptions, and asks for what it wants. Searching grants
nothing, and each tool's own gate still runs at call time. See [the skills command](../commands/skills.md).

## A post-mortem that writes skills

When `improvement_policy` allows it and the host injects an extractor, closing a hard task (several
steps, a failure then a success, or low initial confidence) runs a post-mortem (`postmortem.ts`): the
model reads the transcript and result and extracts the lesson. The result is a new skill, written
by `skill-writer.ts`:

1. `renderSkill` is deterministic, so the content hash is stable, and `safeSkillName` removes path
   traversal from a model-chosen name.
2. `skill-review.ts` vets the draft in memory (`scanForInjection` and a danger review) before it
   touches disk, in every posture; a dangerous body is refused even under `autonomous`.
3. The governance gate then decides: blocked if `locked`, queued under `skills/pending/` if
   `suggesting`, written to `skills/` if `autonomous`.
4. The new skill is registered in the ledger (`skill-lifecycle.ts`) with its provenance.

It is wired through `AgentOptions.postmortem` and fires best-effort at the run's success points. A
persona without an injected extractor never reflects. Only the new-skill destination exists today;
routing a lesson to a refinement of an existing skill, a memory entry or a spec self-edit is not built.

## Planning, re-evaluation and the loop breaker

- A run configured with `AgentOptions.plan` asks the model for a plan before acting. `assessPlan`
  (`planner.ts`) checks each step against the sandbox and the hard limits, and a plan that violates
  a hard limit is rejected without executing anything (`plan-run.ts`).
- `LoopBreaker` (`loop-breaker.ts`) forces a strategy change or a stop with a diagnosis when the same
  tool fails with near-identical arguments `repeatLimit` times (default 3) or a run makes no progress
  for `stallLimit` steps (default 5).

## Context

`context.ts` auto-compacts at 0.8 of the window, and a `ContextMeter` tracks fill.

- Task state (`task-state.ts`, `TaskStateTracker`) is pure and bounded. Its rendered block is pinned
  as system speech ahead of the summary on compaction, so the goal and plan outlive the transcript.
- Large tool outputs are offloaded (`tool-output-store.ts`) to a handle such as `out-N` and recovered
  with `read_output` and `grep_output`. In a check, a 54,912-character log became 981 characters in
  context, and a buried error line was recovered with `grep_output`.
- `tool-repair.ts` repairs malformed tool results, and the loop breaker takes over when the failure persists.

## The persona writes its own list: `update_tasks`

`tools/update-tasks.ts`: the persona sends its whole list each time, every step `pending`,
`in_progress`, `done` or `blocked`. The loop handles the call, because a step counts as done only
when a call that succeeded in this run backs it, and only the loop has seen those
(`TaskStateTracker.replaceTasks`). One call backs one step. A step marked done with nothing behind it
is kept as said done and shown as `[?]`, to the model and to the person. After every batch of calls
the list goes back to the end of what the model reads, as one replaced message, so it never grows the
context. The persona's record keeps the list the turn ended with as a `tasks` entry written by the
runtime. A session that pins a tool subset reaches the list through `find_tools`.

## Deciding before acting, for models that need it

A model can be given a scaffold (`core/src/run/model-seam.ts`): `standard`, the loop as it is, or
`small`, which adds one short step before the loop. The step is a call with no tools that asks for one
JSON object naming the route and why: `answer`, `ask`, `consult` (read its own references or examples
first), `skills`, `delegate` or `work` (`run/decide.ts`). The route comes back as a runtime note after
the person's message and takes no tool away. `work` also goes through the planning gate
(`runPlanPhase`). When no usable plan comes out, the turn acts without an anchor and says why, and the
gate still judges each call; a run an operator configured to plan keeps the stricter rule of no
runnable plan, no run. A reply that cannot be read leaves the turn without a route, shown on the
activity line. The record keeps a `decision` entry in the persona's name; a `standard` turn has none.

The scaffold comes from the model's own settings, then the destination table (`scaffoldFor` in
`run/destinations.ts`), then `standard`. The table declares no model `small` yet: a model is declared
`small` only after the bench shows the step helps it. A request that offers no tools carries no
`tools` and no `tool_choice`, because HuggingFace's router answers HTTP 400 to an empty list with a
choice.

## Asking for what is missing: `ask_person`

`tools/ask-person.ts`: a question, two to four options, and the one the persona recommends. The loop
handles the call, because only the run knows whether anybody is there.

- With somebody in front of it (the TUI passes `onQuestion` when it has a terminal), the question is
  shown numbered. A number or a label picks that option, anything else is the person's own words, and
  nothing typed is no answer, never the recommendation.
- With nobody (a service step, a delegated sub-task, a headless run), the turn stops at the question
  and leaves it written, as `stopped` with the question as its result. A sub-task never receives its
  parent's way to reach a person, so its question travels back up to whoever delegated it.
- A service step that stops at a question leaves its run `waiting`, with the question and options as
  the reason. It is picked up with `service.resumeService`
  ([`service resume`](../commands/service.md#picking-a-waiting-run-up)): the step that asked runs
  again with the question and answer in its prompt, and earlier steps are not run again.

The record keeps a `question` entry in the persona's name and, when somebody answered, an `answer`
entry in the name of whoever opened the turn.

## Running a service: `run_service`

`tools/run-service.ts`: the service and the client's request in their own words. Its gate asks
whatever the posture, because the loop's verdict is the strictest of its guards and consent only
tightens it. The question carries what is being approved: which service, how many steps, what it
leaves, and on what request. The tool runs nothing itself; the host lends the way to run one. A turn
whose host cannot is never shown it, and neither is a persona that delivers no service, a read-only
persona, a delegated sub-task or a service step, which keeps a service from starting another from
inside a run. See [`service`](../commands/service.md).

## Security

Every tool call passes the gate, and a policy violation aborts the run. The postures that decide what
a call may do are in [sandbox](./sandbox.md).

## Not built

- Continuous evaluation: `packages/evals` measures success, cost and steps by task type, but it is
  not yet wired to trigger the post-mortem on a measured regression.
- Delegation to other personas with their own budgets. Today `delegate` hands a piece of work to a sub-run of the same persona.
- Seed-and-decision-log replay of a run.
