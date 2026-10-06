# `personaxis sync`

Reconcile a persona's runtime state across machines. The same persona can live on several
machines (Windows, Linux, macOS) and reconcile through git. Passing another machine's `state.json`
merges it into this one without clobbering: the two mutation logs are combined, and each value
takes the latest write per field.

```bash
personaxis sync ../other-machine/state.json -p .personaxis/personaxis.md --dry-run   # show the merge report, write nothing
personaxis sync ../other-machine/state.json -p .personaxis/personaxis.md
```

| Arg / flag | Meaning |
|---|---|
| `<other-state>` | Path to the other machine's `state.json`. |
| `-p, --persona <path>` | Required. This machine's `personaxis.md` / `PERSONA.md`. |
| `--dry-run` | Print the merge report without writing. |
| `--status` | Show what the per-device logs hold and what a merge would produce. |
| `--rebuild` | Recompute `state.json` from the per-device logs. |

Mutations carry an `origin_node` and a `session_id`, so the merge is deterministic and auditable.

## Multi-device

```bash
personaxis sync --status -p .personaxis/personaxis.md     # who has contributed, chain health, what a merge produces
personaxis sync --rebuild -p .personaxis/personaxis.md    # recompute state.json from the per-device logs
```

The persona's state is a fold of one append-only log per device
(`.personaxis/devices/<id>/mutations.jsonl`). Every machine writes only its own file, so
they never overwrite each other, whatever carries the folder between machines (git,
Syncthing, Dropbox, a USB stick). `state.json` is a cache of that fold: delete it and
`--rebuild` brings it back.

Passing an `<other-state>` file is the older reconciliation: merge one machine's `state.json`
into this one, last write wins per field. It still works for one-off imports, but the per-device
logs are the mechanism.

Full rationale, including why wall-clock timestamps cannot order distributed edits and why
the clamp is applied per entry: [`docs/architecture/multi-device.md`](../architecture/multi-device.md).
