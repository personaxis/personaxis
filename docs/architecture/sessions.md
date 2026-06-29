# Sessions: persistent, per-persona conversations

The REPL keeps the live conversation in memory and re-sends it each turn — correct for
continuity, but it vanishes on exit. Sessions persist it to disk so a user can leave and
`/resume`, the way Claude Code does. Sessions are a runtime artifact with no schema (same
status as `episodic.jsonl` / `self-edits.jsonl`).

Source: `packages/core/src/sessions.ts`; `packages/cli/src/repl/index.ts`.

## Layout

One append-only `<id>.jsonl` per conversation: a header line, then one line per turn. The
layout mirrors the rest of the persona's artifacts and recurses:

```
.personaxis/sessions/<id>.jsonl                       ← root sessions
.personaxis/personas/<slug>/sessions/<id>.jsonl       ← a sub's sessions
```

The id is a filesystem-safe, sortable ISO timestamp plus a short random suffix
(`newSessionId`). A turn's `kind` is one of `root | sub | direct-sub | delegation`. A turn
`role` of `note` marks a non-conversational provenance entry (e.g. a delegation record);
notes are dropped when a session is rehydrated.

## API

`ensureSession` (writes the header, no-op if it exists) · `appendTurn` · `readSession`
(header + turns) · `loadConversation` (rehydrate to `ChatMessage[]`, notes dropped) ·
`listSessions` (newest-activity first) · `renameSession` · `findSession` (exact id, else
case-insensitive name fragment). Auto-titling: `nameSession` asks the LLM for a 2-5 word
title (best-effort, may throw); `fallbackName` is the deterministic fallback (first six words
of the first user message).

## REPL integration

- `Ctx.sessionId` tracks the active session; `recordTurn` persists each user/assistant pair
  and auto-names the session after the first turn (`nameSession`, falling back to
  `fallbackName`).
- `/sessions` lists this persona's sessions, marking the active one `● live`.
- `/resume <id|name>` rehydrates `ctx.conversation` from the file and re-estimates the
  context meter.

## Delegation

When the root delegates to a sub, the act is recorded as a `note` turn in the **root's**
session (provenance), and the episodic write respects `memory.types.episodic` (see
[memory.md](./memory.md)). The sub runs its own session independently.

## Relation to `/compact`

Sessions and `/compact` are orthogonal (`context.ts`):

- `/compact` summarizes old turns via the LLM (automatically at 0.8 of the context window).
  It compresses the **live** context to fit the window.
- Sessions persist the conversation to **disk** for `/resume`.

One compresses what is in memory; the other saves it across runs.
