# `personaxis goal`, the standing objective

```bash
personaxis goal                                    # show it
personaxis goal Ship the onboarding redesign       # set it (the words are joined)
personaxis goal --clear                            # remove it
personaxis goal --json
```

A goal is the objective the persona carries across turns: every Living-Loop tick is
evaluated against it until it is cleared, and it rides in the runtime context, so the
persona can answer "what is my goal" without searching its memory. It is stored in
`goal.json` beside the persona's spec.

In the app, set it in `/persona`, Evolution tab (Enter on the `goal` row; an empty answer
clears it). Use this command from scripts and agents; the app and the command write the same
file.

| Flag | Effect |
|---|---|
| `[text...]` | the new goal; omit it to show the current one |
| `--clear` | remove the goal |
| `-p, --persona <path>` | which persona (default: the one in scope) |
| `--json` | emit `{ specPath, goal }`, with `goal: null` when none is set |
