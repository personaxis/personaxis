# `personaxis state`

Inspect and move the persona's runtime state (`state.json`): the current value of every
mutable field, each **clamped** to the envelope its spec declares. This is separate from
self-evolution, which edits the spec itself under governance.

`state.json` is a view printed from the hash-chained record (`record.jsonl`) beside the spec,
so every move is recorded first and a deleted `state.json` comes back on the next read.

## Usage

```bash
personaxis state show                                   # the current values and the last moves
personaxis state drift                                  # how far each value sits from its centre
personaxis state mutate --field <dotpath> --delta <n> --reason "<why>"
personaxis state rewind <n>                             # undo the last n moves, recorded
personaxis state rebuild                                # check state.json against the record
personaxis state init                                   # seed state.json from the envelope means
```

Every subcommand works on the persona in scope, the same one `status`, `lint` and `goal`
use: `.personaxis/personaxis.md` in the current folder, then a pre-v1 `PERSONA.md` with
frontmatter, then the nearest one up the tree. `-f <path-or-slug>` picks another one
(`-f .personaxis/personas/cmo/personaxis.md` or `-f cmo`).

| Subcommand | Flags |
|---|---|
| `show` | `--json` |
| `drift` | `--json`; exits 2 when a layer drifts past its `governance.drift_thresholds`, so CI can gate on it |
| `mutate` | `--field`, `--delta`, `--reason` (required), `--actor` (default `human-operator`), `--tool-call-id` |
| `rewind <n>` | `--dry-run` shows what would move and writes nothing; `--json` |
| `rebuild` | `--write` reprints `state.json` from the record (default: report only); `--json` |
| `init` | `--force` |

## Clamping and governance

A move is clamped to the declared `mean ± range`, and the record says `clamped: true` when
the requested delta went past it. Traits that back a hard-enforced virtue cannot move for
anybody. A move by a person (`--actor human-operator`, the default) applies under any
`improvement_policy.mode`; a move by the model (`actor-llm`) is subject to the mode and to
`max_step_delta`, and a refusal is itself recorded.

## Rewind keeps the history

`state rewind <n>` works out the values as they were before the last `n` moves and puts them
back with new, ordinary moves. Nothing is truncated: the moves being undone and the rewind
both stay in the record, so an audit shows that somebody undid something. Inside the app the
same action is on `/audit → Timeline`.

## Example

```bash
personaxis state mutate --field mood.tone --delta -0.10 --reason "user reported frustration"
personaxis state rewind 1 --dry-run
personaxis state rewind 1
```
