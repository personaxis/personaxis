# `personaxis sync`

Reconcile a persona's **runtime state across machines** — merge another machine's `state.json` into
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
