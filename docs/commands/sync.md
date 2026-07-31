# `personaxis sync`

Reconcile a persona's **runtime state across machines**: merge another machine's `state.json` into
this one **without clobbering** (mutations are combined, not overwritten). This is the portable
"user-clone" pattern: the same persona lives on your Windows/Linux/macOS clones and reconciles via git.

```bash
personaxis sync ../other-machine/state.json --dry-run        # show the merge report, write nothing
personaxis sync ../other-machine/state.json --persona ./.personaxis/personaxis.md
```

| Arg / flag | Meaning |
|---|---|
| `<other-state>` | Path to the other machine's `state.json`. |
| `-p, --persona <path>` | This machine's `personaxis.md` / `PERSONA.md` (default: resolve locally). |
| `--dry-run` | Print the merge report without writing. |

Mutations carry an `origin_node` + `session_id` (v0.8), so the merge is deterministic and auditable.

## Multi-device (V8)

```bash
personaxis sync --status     # who has contributed, chain health, what a merge produces
personaxis sync --rebuild    # recompute state.json from the per-device logs
```

The persona's state is a **fold of one append-only log per device**
(`.personaxis/devices/<id>/mutations.jsonl`). Every machine writes only its own file, so
they never overwrite each other, whatever carries the folder between machines (git,
Syncthing, Dropbox, a USB stick). `state.json` is a cache of that fold: delete it and
`--rebuild` brings it back.

The passing of a `<other-state>` file is the older, pre-V8 reconciliation (merge one
machine's `state.json` into this one, last-writer-wins per field). It still works and is
still useful for one-off imports, but the per-device logs are the mechanism.

Full rationale, including why wall-clock timestamps cannot order distributed edits and why
the clamp is applied per entry: [`docs/architecture/multi-device.md`](../architecture/multi-device.md).
