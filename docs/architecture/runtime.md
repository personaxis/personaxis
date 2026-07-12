# The runtime, end to end

This is the authoritative map of what happens at run time: how input reaches a persona, every
phase it passes through, what is written where, and how each case is handled. It is the spine;
the deep-dive docs it links to ([memory](./memory.md), [sessions](./sessions.md),
[self-evolution](./self-evolution.md), [sandbox](./sandbox.md), [math-core](./math-core.md),
[compile](./compile.md)) own the specifics and are not repeated here.

Every claim below cites the code that implements it, so the document is auditable. Paths are
relative to the repo root.

---

## 1. Where input enters (two planes, four surfaces)

The engine (`@personaxis/core`) runs on **your configured model**, never the host's. A consumer
drives it through exactly one of four surfaces. Each surface reduces to a single call into the
engine: `LivingLoop.tick({ observation, source })` (`packages/core/src/loop.ts:97`).

| Surface | Entry point | What it passes to `tick` | Mode |
|---|---|---|---|
| Host hook | `personaxis observe --stdin` (`packages/cli/src/commands/observe.ts`) | the captured turn (see §2) | 1, dev companion |
| MCP tool | `persona_observe` (`packages/mcp`) | the observation the agent chose to send | 1, on-demand |
| SDK | `persona.observe(observation, source)` (`packages/sdk/src/index.ts:136`) | whatever your backend passes | 2, embed |
| HTTP | `POST /persona/observe` (`packages/cli/src/commands/serve.ts`) | request body `{ observation, source }` | 2, service |

The REPL (`personaxis` with no subcommand) is the interactive form of the SDK path: each user
turn becomes one `tick`. `serve` also exposes `GET /persona/state`, `GET /persona/audit`,
`POST /persona/adjust`, and `POST /persona/agent` (the agent loop, §5).

Deployment shapes and the two modes are in [deployment.md](./deployment.md). Serverless has no
long-lived process: call `observe` per request, or run `personaxis watch --once` from a cron
(`packages/cli/src/commands/watch.ts:42`).

## 2. The observation (the unit of input)

An observation is a **single string** plus a provenance `source` (`user | tool | internal |
synthesis`, `packages/core/src/appraisal.ts`). It is the only thing the engine ingests. It is
**not** the full conversation, the reasoning, or the tool trace unless a caller deliberately puts
that text in the string.

**What the host hook actually captures** (`observationFromHookPayload`,
`packages/cli/src/commands/observe.ts:103`) is deliberately bounded:

- Claude Code Stop hook: reads `transcript_path`, takes the **last 8 JSONL lines**, keeps the
  **last 2 `user`/`assistant` messages**, and **truncates to 1200 characters**.
- Codex Stop hook: `last_user_message` + `last_assistant_message`, capped at 1200.
- Other hosts / raw pipes: `prompt`, `message`, `context`, or raw text, capped at 1200.
- `readStdin` has a 1500 ms timeout (`observe.ts:84`) so a hook never blocks the host.

Consequences, stated plainly:

- A **huge response** contributes only its tail (~1200 chars of the last exchange).
- A **multi-step agent turn** (many tool calls in one response) is not expanded; only the last
  visible message is seen through the hook.
- **Reasoning / thinking** is never captured by the hook (it filters to `user`/`assistant` text).

This is a design choice: the per-turn signal is cheap, bounded, and spends no host tokens. To
learn from more than the tail, a caller passes a richer `observation` explicitly through MCP,
SDK, or HTTP; the hook default will not do it for you. See §7.

## 3. One governed tick, phase by phase

`LivingLoop.tick` (`packages/core/src/loop.ts:97`) is the whole lifecycle. Every phase emits an
auditable event on the bus; nothing is a black box.

1. **Observe + injection scan** (`loop.ts:101`). `scanForInjection` runs on the observation. A
   `malicious` verdict sets `injectionBlocked`, which forbids evolution and self-edits this turn
   (the content may still be remembered, tagged `injection-flagged`). Any non-clean verdict emits
   an `anomaly` event.
2. **Apply the self-edit overlay + read envelopes** (`loop.ts:117`). Approved governed self-edits
   live as an **overlay** merged onto the frontmatter at tick time; the spec file
   (`personaxis.md`) is never mutated in place. Envelopes (`{mean, range}`) are extracted from the
   merged view.
3. **Appraise** (`loop.ts:138`). The appraiser (your model via `LlmAppraiser`, or the offline
   `HeuristicAppraiser`) receives the observation, the persona body, the mutable fields, and a
   grounded evolution view, and returns **structured signals only**:
   `{ confidence, mutations, selfEdits, preferences, memories }`. The model proposes; it never
   writes free text into state. An appraiser error degrades to "no evolution this turn" and the
   persona still replied (`loop.ts:146`). `confidence < 0.2` -> **abstain**, nothing changes
   (`loop.ts:154`).
4. **Govern, then clamp and audit** (`loop.ts:159`). `governMutations` admits or rejects each
   proposed delta against the envelopes and the governance mode. Under a lock (`loop.ts:189`), the
   engine re-reads fresh state, applies the **homeostatic decay first** (`applyHomeostasis`), then
   the admitted deltas (`applyMutation`), each **clamped to its envelope** and appended to
   `state.json#/mutation_log` with actor, reason, origin node, session id, and a `clamped` flag.
5. **Drift** (`loop.ts:225`). A normative drift event is a **band crossing**, not any mutation
   (within-band movement is expression variance). `driftReport` computes per-layer drift `D`
   against `governance.drift_thresholds`; a layer over threshold emits a `drift-threshold`
   anomaly.
6. **Qualitative self-edit** (`loop.ts:251`). Proposed spec edits require `confidence >= 0.6`, no
   injection, and pass `editGate`, which composes the safety floor + the author's
   `per_layer_edit_policy` + the global `improvement_policy.mode` into `block | queue | auto`:
   - `locked` -> nothing.
   - `suggesting` -> queued for `/review`.
   - `autonomous` -> applied, still gated by verifiers, protected paths, and a provenance gate
     that requires a `user`-trust justification.
   Applied edits update the overlay (phase 2), not the spec file. Full model in
   [self-evolution.md](./self-evolution.md).
7. **User preferences** (`loop.ts:283`). Written only when `memory.types.user_preferences` is
   declared and no injection was seen.
8. **Memory** (`loop.ts:290`). Episodic notes are written **only if `memory.types.episodic`** is
   declared, and only the appraiser's distilled `memories[].content`, not the raw observation. The
   hash chain is verified before every append (`loop.ts:300`); a broken chain refuses the write.
   Then anomaly detection, optional episodic->semantic consolidation into `memory.md`, and optional
   deterministic `evaluations` scoring. The six memory kinds are in [memory.md](./memory.md).
9. **Recompile** (`loop.ts:352`). `PERSONA.md` is regenerated **only on a band crossing**, not on
   every mutation. This keeps recompiles rare and spec-faithful.

`tick` returns `{ mutationsApplied, memoriesWritten, abstained }` and always emits
`tick-complete`.

## 4. What is persisted, and when

| Artifact | Written | Contents |
|---|---|---|
| `state.json` | every tick with an admitted mutation or a decaying field | current values + `mutation_log` (actor, reason, clamp/block flags, origin, session) |
| `memory/episodic.jsonl` | when `memory.types.episodic` and the appraiser proposes memories | hash-chained distilled notes, provenance-tagged |
| `memory.md` | on episodic->semantic consolidation | consolidated semantic memory |
| user preferences / evaluations | when those `memory.types` are declared | key/value prefs; deterministic quality scores |
| self-edit overlay | when a governed self-edit is applied or queued | the change set merged at tick time; `personaxis.md` stays untouched |
| `PERSONA.md` | on a band crossing | recompiled identity the consumer reads |

The raw observation, the full transcript, and reasoning are **not** persisted anywhere by the
tick. What survives is the audited numeric change (`mutation_log`) and the distilled notes
(episodic).

## 5. Three things people conflate: tick, agent loop, session

- **Tick** (`observe`): one appraisal cycle over one observation (§3). Updates state and memory.
  No conversation is stored.
- **Agent loop** (`agentRun` / `POST /persona/agent`, `packages/sdk/src/index.ts:172`,
  `packages/core/src/agent.ts`): a multi-step, tool-using loop bounded by `maxSteps` and the
  persona's `agent_budget`, with every tool call **sandbox-gated** by the permission policy
  ([sandbox.md](./sandbox.md)) and an optional verification judge. It writes an observability
  **trace**, not the living-loop state, unless you also call `observe`.
- **Session**: persistent conversation history for the **REPL** (`/sessions`, `/resume`,
  `/compact`; `packages/core/src/sessions.ts`, `session-writer.ts`). The hook/observe path does
  **not** create a session. Details in [sessions.md](./sessions.md).

So "sessions are only for a direct CLI conversation" is correct: they are a REPL feature. Learning
through hooks happens without any session, as ticks against `state.json` and memory.

## 6. The case matrix

| Case | What the engine does |
|---|---|
| Short user turn | one tick; appraise -> maybe clamp a value + write a note |
| Huge response | only the last ~1200 chars of the last exchange are appraised (§2) |
| Multi-step agent turn (via hook) | only the last visible message is seen; intermediate steps are not captured |
| Multi-step you want fully learned | drive `agentRun` for the tool loop, and/or send explicit observations via SDK/MCP (§7) |
| Reasoning / thinking | not captured by the hook; pass it explicitly if you want it appraised |
| Malicious / injection | `injectionBlocked`: no mutations, no self-edits; content may be remembered, tagged |
| Low confidence (`< 0.2`) | abstain; nothing changes |
| Offline / no model | `HeuristicAppraiser` runs; the loop still governs, clamps, and remembers |
| Appraiser unreachable | degrade to "no evolution this turn"; the persona still replied |
| Drift over a layer threshold | `drift-threshold` anomaly emitted; the clamp already held the value |
| `locked` / `suggesting` / `autonomous` | self-edits are dropped / queued / auto-applied under gates (§3.6) |
| Concurrent writers (serve + MCP + tick) | serialized by a state lock; deltas are relative to fresh state (`loop.ts:189`) |
| Serverless (no daemon) | call `observe` per request, or `watch --once` from a cron |

## 7. Bounds and how to feed richer input

The bound that matters: **the hook captures a 1200-char tail of the last exchange and no
reasoning.** It is a lightweight signal, not a full-fidelity record. To have a persona learn from
more, the caller supplies the observation explicitly:

- **MCP**: the host calls `persona_observe` with whatever text it decides is worth learning from
  (a summary of the whole task, a tool result, a decision).
- **SDK / HTTP**: your backend composes the observation string (it can summarize a long
  multi-step interaction before sending it).

There is no automatic full-transcript or reasoning ingestion today. If that is wanted, it is a
new capability (a richer host-side capture that summarizes a turn before calling `observe`), not
something the current hook does.

## 8. Auditing the runtime

Everything above is verifiable after the fact:

- `personaxis audit` / `GET /persona/audit`: mutation count, memory size, hash-chain integrity,
  anomalies.
- `personaxis state drift`: per-coordinate position, band, and the T3 evidence cost.
- `personaxis state rebuild`: replays `mutation_log` to reconstruct `state.json` and detect
  tampering.
- The event stream (`observe`, `appraise`, `govern`, `mutate`, `drift`, `self-edit`, `memory`,
  `recompile`, `anomaly`, `tick-complete`) is the per-tick audit log.

Guarantees behind these (T1..T6) are in [../GUARANTEES.md](../GUARANTEES.md) and mapped to code in
[math-core.md](./math-core.md).
