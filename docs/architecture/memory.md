# Memory: the six `memory.types`, enforced

A persona's `memory.types` declares six memory kinds. All six are real producers and
consumers. Each kind honors its `memory.types.<kind>` flag at the producer call site, so a
persona that does not declare a kind writes nothing for it.

Source: `packages/core/src/{memory.ts, memory-kinds.ts, loop.ts, agent.ts}` and
`packages/core/src/memory/{knobs,facts,retrieval,consolidate}.ts` (the V2 engine).

## The six kinds

| Kind | Storage (beside the persona) | Producer | Consumer |
|---|---|---|---|
| `episodic` | `memory/episodic.jsonl` (append-only, hash-chained) | the Living Loop (salient lines only) + session distillation | recall window, `memory_search`, audit |
| `semantic` | `memory.md` | `consolidateSemantic` (salience-ranked digest) | always loaded into context |
| `procedural` | `memory/procedural.jsonl` (append-only) | `agent.persist` on a successful task (how-to per task) | `resumeContext`, `memory_search` |
| `autobiographical` | `memory/autobiographical.jsonl` (append-only) | milestones: first conversation, a user fact learned, a band crossing, improvement-mode changes | recall, `memory_search` |
| `user_preferences` | `memory/preferences.json` (last-wins map) | the appraiser proposes `preferences[]`; a dotted `<subject>.<attribute>` key is an ENTITY FACT (any subject), a dot-free key is a loose preference | the `# Known facts` block (facts, grouped by subject) ALWAYS loaded first; preferences loaded after |
| `evaluations` | `memory/evaluations.jsonl` (append-only) | `scoreMemoryEntry`, per turn in the loop | salience ranking, quality review |

## The V2 recall architecture (who reads what, when)

One design rule: the raw dialog lives ONCE, in `sessions/<id>.jsonl`. Everything else is
derived, and each artifact has a declared role:

- **Always in context** (every turn, `agent.resumeContext`): the `# Known facts` block (all
  subject-qualified facts, grouped by subject, `+ memory.working_self + memory.anchors`), the
  previous-session recap (derived at read time from the newest other session, no summary
  artifact), the consolidated `memory.md`, and a today/yesterday episodic window bounded by
  `runtime.memory.max_items`.
- **On demand**: the `memory_search` / `memory_get` agent tools (lexical BM25 across every
  kind; `use_embeddings` ranks via the endpoint's `/embeddings` when it serves them;
  `use_reranker` re-ranks the lexical top-k with the chat model). The system prompt tells
  the model to search before claiming it does not remember.
- **At session close** (`closeSession`): the session is DISTILLED into 3-8 persistent
  episodic entries (facts / decisions / one event line, tagged `distilled` + `kind:*` +
  `from:<session>`, idempotent), `memory.md` is re-consolidated when
  `consolidation_policy.mode: auto`, and the retention window prunes (tombstones) stale
  un-anchored entries.

## Entity facts, not "the user"

Facts are general: the SUBJECT of a fact is any named entity, the ambient interlocutor (a
human, another agent, or an app), a named person / agent / app, the project, a system. A
preference key with a dot is a subject-qualified fact (`<subject>.<attribute>`, e.g.
`interlocutor.name`, `project.deadline`, `agent:reviewer.owner`), always loaded and grouped by
subject; a key without a dot is a loose preference. Nothing hardcodes "user" (`memory/facts.ts`).

Offline fact extraction (`memory/facts.ts`): deterministic ES/EN presentation patterns
("me llamo X", "my name is X", "call me X") persist `interlocutor.name`/`interlocutor.alias`
with NO model configured; the LLM appraiser proposes the same `subject.attribute` shape and can
attribute a fact to any subject. Even the offline reflective responder addresses a known party
by name, whatever the subject. The user's-name case is one instance of this general logic.

## Spec knobs, consumed (documented assumptions where SPEC is silent)

- `runtime.memory.max_items`: bounds every recall window and search result (default 20).
- `runtime.memory.use_embeddings` / `use_reranker`: retrieval behavior above; when the
  backend cannot honor them the fallback is STATED in the tool observation, never silent.
- `runtime.memory.retention_days_default`: the pruning window; absent = keep forever.
- `memory.write_policy.default`: `ephemeral` persists nothing (abstain event), `session`
  tags entries to their session (recalled only there unless distilled/typed), `persistent`
  (and an absent block) writes untagged, the pre-V2 behavior.
- `memory.consolidation_policy.mode`: `auto` consolidates inline; `assisted` emits a
  proposal (run `/memory consolidate`); `manual` only ever consolidates on command.
  Absent = `auto` (the pre-V2 behavior).
- `memory.anchors`: injected into the known-facts block and never pruned.
- `memory.working_self`: injected as the known-facts block's self-model line.

Storage mirrors episodic memory: append-only JSONL under `<personaDir>/memory/`, except
`user_preferences`, which is a small last-wins JSON map (`setPreference` overwrites by key).
The layout recurses with the persona, the root's under `.personaxis/memory/`, a sub's under
`.personaxis/personas/<slug>/memory/`.

## Flag-gating

Every producer checks `readMemoryTypes(frontmatter).<kind>` before writing. Examples from
`loop.ts`: episodic entries are written only when `memory.types.episodic` is declared;
`user_preferences` are written only when declared *and* never under a malicious injection.
This keeps the spec's `memory.types` declaration load-bearing rather than decorative.

## The evaluations scorer

`scoreMemoryEntry` (`memory-kinds.ts`) is a deterministic, offline scorer, no LLM. For each
episodic entry it emits one `EvaluationEntry` per dimension:

- `safety`, `0` when the content was injection-flagged (`opts.injectionBlocked` or the
  `injection-flagged` tag), else `1`.
- `usefulness`, a `sourceWeight` (0.6 for `user`/`synthesis`, else 0.35) plus a
  length term (`min(0.4, len/600)`), clamped to `[0,1]`; flagged content scores `0.1`.

The loop runs this each turn and appends to `memory/evaluations.jsonl`.

## Visibility (per turn)

You can see, every turn, both the memory **created** and the memory **used to answer**: plus
the evaluations *with their actual scores*, not an opaque counter. Three bus events drive this:

- **`memory`**: an episodic entry was written; the REPL shows `memory +1 episodic ([user] …)`.
- **`memory-recall`** (`{ kind, count, detail }`, emitted by `agent.resumeContext`), a memory
  kind was injected to answer this turn; the REPL shows `recalled episodic×2 (…)`. This answers
  "did it *use* any memory to respond?".
- **`evaluation`** (`{ target, dimension, score, rationale }`, one per score from the loop), the
  REPL shows `evaluated #a1b2c3d4 usefulness 0.74 · turn safety 1.00`, instead of `+N eval(s)`.

A compact `memory-kind` rollup (`{ kind, detail }`) is still emitted for `procedural` /
`autobiographical` / `user_preferences`. Inspect the full picture any time with **`/memory`**
(all six kinds, with `(off)` for a disabled type) and **`/audit`** (self-edit ledger + recent
evaluations with scores). Tests: `packages/core/test/loop-observability.test.ts`.

## Cross-persona access: read-only

A root may **read** a sub-persona's memory files at the filesystem level but never **write**
them. The sandbox policy's cross-persona deny rules block any cross-persona write (deny has
the highest precedence, see [multi-persona.md](./multi-persona.md) and
[sandbox.md](./sandbox.md)). So a parent can consult a child's episodic/semantic memory for
context, but each persona's memory is written only by that persona.
