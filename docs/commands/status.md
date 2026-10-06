# `personaxis status`, what a persona is right now

The snapshot, as a subcommand, so an agent or a CI job can read it without opening the TUI.

```bash
personaxis status                          # the persona in scope
personaxis status -p .personaxis/personas/legal/personaxis.md
personaxis status --json                   # machine-readable
```

Reports the persona's name and role and where its spec lives, the model that would answer for it,
the session posture and its improvement mode, its overall distance from its baseline (`D`),
which memory kinds it keeps, and how many governed mutations it has recorded. For the
coordinate-by-coordinate movement, see [`drift`](./drift.md).

The TUI's `/status` shows the same data.

| Flag | Effect |
|---|---|
| `-p, --persona <path>` | which persona to inspect (default: the one in scope) |
| `--json` | emit JSON: name and role, spec path, improve mode, state values, mutation count, memory kinds |
