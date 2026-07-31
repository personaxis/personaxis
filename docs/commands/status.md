# `personaxis status`, what a persona is right now

The snapshot, as a subcommand, so an agent or a CI job can read it without opening the TUI.

```bash
personaxis status                          # the persona in scope
personaxis status -p .personaxis/personas/legal/personaxis.md
personaxis status --json                   # machine-readable
```

Reports identity and where its spec lives, the model that would answer for it, the session
posture and its improvement mode, global drift `D`, which memory kinds it keeps, and how
many governed mutations it has recorded.

**Status is the snapshot, not the delta.** "How far has it moved from what it declared" is
a different question, answered by [`drift`](./drift.md) across three planes. The two used to
print the same envelope block, which made one of them redundant.

Same collector as the TUI's `Settings > Status`, so the terminal and the pipe cannot
disagree.

| Flag | Effect |
|---|---|
| `-p, --persona <path>` | which persona to inspect (default: the one in scope) |
| `--json` | emit JSON: identity, spec path, improve mode, state values, mutation count, memory kinds |
