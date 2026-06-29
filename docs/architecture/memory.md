# Memory: the six `memory.types`, enforced

A persona's `memory.types` declares six memory kinds. All six are now real producers and
consumers — previously only `episodic` + `semantic` were wired and the other four were a
facade. Each kind honors its `memory.types.<kind>` flag at the producer call site, so a
persona that does not declare a kind writes nothing for it.

Source: `packages/core/src/{memory.ts, memory-kinds.ts, loop.ts, agent.ts}`.

## The six kinds

| Kind | Storage (beside the persona) | Producer | Consumer |
|---|---|---|---|
| `episodic` | `memory/episodic.jsonl` (append-only, hash-chained) | the Living Loop, per turn | `resumeContext`, audit |
| `semantic` | `memory.md` | `consolidateSemantic` (grouped by source) | compile / context |
| `procedural` | `memory/procedural.jsonl` (append-only) | `agent.persist` on a successful task (how-to per task) | `resumeContext` |
| `autobiographical` | `memory/autobiographical.jsonl` (append-only) | improvement-mode changes; identity milestones | recall |
| `user_preferences` | `memory/preferences.json` (last-wins map) | the appraiser proposes `preferences[]` | `resumeContext` |
| `evaluations` | `memory/evaluations.jsonl` (append-only) | `scoreMemoryEntry`, per turn in the loop | quality review |

Storage mirrors episodic memory: append-only JSONL under `<personaDir>/memory/`, except
`user_preferences`, which is a small last-wins JSON map (`setPreference` overwrites by key).
The layout recurses with the persona — the root's under `.personaxis/memory/`, a sub's under
`.personaxis/personas/<slug>/memory/`.

## Flag-gating

Every producer checks `readMemoryTypes(frontmatter).<kind>` before writing. Examples from
`loop.ts`: episodic entries are written only when `memory.types.episodic` is declared;
`user_preferences` are written only when declared *and* never under a malicious injection.
This keeps the spec's `memory.types` declaration load-bearing rather than decorative.

## The evaluations scorer

`scoreMemoryEntry` (`memory-kinds.ts`) is a deterministic, offline scorer — no LLM. For each
episodic entry it emits one `EvaluationEntry` per dimension:

- `safety` — `0` when the content was injection-flagged (`opts.injectionBlocked` or the
  `injection-flagged` tag), else `1`.
- `usefulness` — a `sourceWeight` (0.6 for `user`/`synthesis`, else 0.35) plus a
  length term (`min(0.4, len/600)`), clamped to `[0,1]`; flagged content scores `0.1`.

The loop runs this each turn and appends to `memory/evaluations.jsonl`.

## Visibility

Each producer emits a `memory-kind` event on the bus (`{ kind, detail }`). The REPL surfaces
these per turn in the summary line, e.g. `evaluations +2`, `user_preferences +1`.

## Cross-persona access: read-only

A root may **read** a sub-persona's memory files at the filesystem level but never **write**
them. The sandbox policy's cross-persona deny rules block any cross-persona write (deny has
the highest precedence — see [multi-persona.md](./multi-persona.md) and
[sandbox.md](./sandbox.md)). So a parent can consult a child's episodic/semantic memory for
context, but each persona's memory is written only by that persona.
