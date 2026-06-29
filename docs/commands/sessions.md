# `/sessions` and `/resume` — persistent conversations

The REPL persists every conversation so you can leave and come back, the way Claude Code does.

Source: `packages/cli/src/repl/index.ts` (`recordTurn`, the `sessions`/`resume` commands) →
`packages/core/src/sessions.ts`.

## Where conversations live
Per persona, beside its spec — and the layout recurses:
```
.personaxis/sessions/<id>.jsonl                         # the root's conversations
.personaxis/personas/<slug>/sessions/<id>.jsonl         # a sub-persona's conversations
```
Each file is append-only: one header line + one line per turn (same status as
`episodic.jsonl` — a runtime artifact, no schema). Sessions are auto-named from the first
message (via the model when one is configured, else a deterministic fallback).

## Usage
```
/sessions               # list saved conversations (● live = the current one)
/resume <id|name>       # rehydrate a saved conversation (by id or name fragment)
```
`/resume` reloads the messages into the live context and re-estimates the context meter.

## Relationship to `/compact`
Orthogonal. `/compact` (see [its page](./repl.md)) summarizes older turns of the **live**
context via the model to free the window (auto at ~80%); sessions **persist** the conversation
to disk. Compacting a resumed session is fine — it compacts the live copy, the file is intact.

## Delegation provenance
When you delegate with `@slug`, the sub logs its own turn in its own session, and a note is
recorded in the root's session. The episodic-memory copy of a delegation honors
`memory.types.episodic` (it is not written when episodic memory is off).
