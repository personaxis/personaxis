# `/review` — review queued qualitative self-edits

When a persona runs in `suggesting` mode, the appraiser's proposed **qualitative** self-edits
(to `persona_prompting.*`) are queued in the append-only ledger `self-edits.jsonl` rather than
applied. `/review` is the human approval surface for that queue.

Source: `packages/cli/src/repl/index.ts` (the `review` command) → `proposals` /
`applySelfEdit` / `rejectSelfEdit` in `packages/core/src/self-evolution.ts`.

## Usage
```
/review                      # list pending proposals (id, target path, value, rationale)
/review approve <id|all>     # apply one/all (consensus-verified, then PERSONA.md recompiles)
/review reject  <id|all>     # reject one/all
```

## What it shows
Each pending proposal lists its `id`, the `targetPath` (always under `persona_prompting`), a
preview of the new value, and the rationale. Approving runs the full consensus verification
(invariant / envelope-sanity / rationale / qualitative-safety, unanimous) and the protected-path
check; on success it mints a PersonaVersion, marks `PERSONA.md` stale, and the REPL recompiles.

## Modes
- `locked` — nothing is ever proposed; `/review` stays empty.
- `suggesting` — proposals queue here for you to approve in batch (the default for unattended
  hosts: they accumulate without interrupting the chat).
- `autonomous` — proposals auto-apply (still gated); `/review` mainly shows history.

See [self-evolution](../architecture/self-evolution.md) for the full governance model.
