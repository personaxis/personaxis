# `personaxis audit`, the ledger

Every piece of evidence a governed persona produces, in one place. `/audit` in the TUI is
the same four tabs; this is the non-interactive door.

```bash
personaxis audit                           # all four tabs
personaxis audit --tab Integrity           # one of them
personaxis audit --json                    # machine-readable
```

| Tab | What it proves |
|---|---|
| `Timeline` | every state mutation, with its rate, clamps and blocks; the rewind points live here |
| `Integrity` | the memory hash chain, plus the REPLAY that rebuilds state from the log and names anything it cannot explain (T4, T5) |
| `Self-edits` | what the persona proposed to change about itself, and the verdict on each |
| `Evaluations` | the quality and usefulness scores its turns earned |

Nothing here is cached: the chain and the replay are re-derived on every run, which is what
makes them evidence rather than a report.

| Flag | Effect |
|---|---|
| `-p, --persona <path>` | which persona to inspect (default: the one in scope) |
| `--tab <name>` | `Timeline \| Integrity \| Self-edits \| Evaluations` (default: all) |
| `--json` | emit JSON, keyed by tab |
