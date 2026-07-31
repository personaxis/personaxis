# `personaxis goal`, the standing objective

```bash
personaxis goal                            # show it
personaxis goal --json
```

A goal is the objective the persona carries across turns: every Living-Loop tick is
evaluated against it until it is cleared, and it rides in the runtime context, so the
persona can answer "what is my goal" without searching its memory.

**In the app it lives in `/persona` → Evolution**, next to the loop that acts on it: the
loop evaluates against the goal, so separating them would disconnect the two halves of one
idea. Enter on the `goal` row sets or clears it (an empty answer clears).

This subcommand is the door for scripts and agents, which cannot drive a menu.

| Flag | Effect |
|---|---|
| `-p, --persona <path>` | which persona to read (default: the one in scope) |
| `--json` | emit `{ specPath, goal }`, with `goal: null` when none is set |
