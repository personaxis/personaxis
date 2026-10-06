# `personaxis review`, approve or reject queued self-edits

When a persona runs in `suggesting` mode, the appraiser's proposed **qualitative** self-edits
(to `persona.*`) are queued in the append-only ledger `self-edits.jsonl` rather than
applied. `personaxis review` is the human approval surface for that queue.

## Usage
```bash
personaxis review                      # list pending proposals (id, target path, value, rationale)
personaxis review approve <id|all>     # apply one or all (consensus-checked, then PERSONA.md recompiles)
personaxis review reject  <id|all>     # reject one or all
```

Inside the app, the same queue is in `/persona`, Evolution tab.

## What it shows
Each pending proposal lists its `id`, the `targetPath` (always under `persona`), a
preview of the new value, and the rationale. Approving runs the full consensus verification
(invariant / envelope-sanity / rationale / qualitative-safety, unanimous) and the protected-path
check; on success it mints a PersonaVersion, marks `PERSONA.md` stale, and the REPL recompiles.

## Modes
- `locked`, nothing is ever proposed; the queue stays empty.
- `suggesting`, proposals queue here for you to approve in batch, without interrupting the chat.
- `autonomous`, proposals auto-apply (still gated); the queue mainly shows history.

See [self-evolution](../architecture/self-evolution.md) for the full governance model.
