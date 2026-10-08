# `personaxis create`: Genesis

Create another persona in this folder, beside the one [`init`](./init.md) makes: a reviewer next to the
project's main persona, for instance. It runs the same process as `init`, in the same order: this folder,
always; what you want it for, optional; material you point at; the interview; then the persona and its
`PERSONA.md`. Every run produces the same four files: a validated `personaxis.md`, `state.json`,
`PERSONA.md`, and `creation-report.md`, which records where each field came from.

A model is required. Without one, `create` refuses, says how to configure one, and writes nothing.

```bash
personaxis create reviewer                                   # read the folder, ask what it is for, interview
personaxis create reviewer "blocks merges without tests"     # what it is for, given up front
personaxis create voice --from-import SOUL.md                # also read a SOUL.md, a card or a system prompt
personaxis create tutor --from-transcript sessions.txt       # also read example conversations
personaxis create auditor --research "API security review"   # also read the field on the web
```

`<name>` is its folder: `.personaxis/personas/<name>/`. Every source is numbered (S1, S2, ...) and the
model reads them together; what you say it is for wins over the folder when they disagree. The options are
the same as `init`'s: `--from-import`, `--from-transcript`, `--research`, `--profile`, `--yes`, `--json`,
`--provider` and `--no-compile` (see [`init`](./init.md)).

## How it is written

Eleven stages, from identity to governance. Each prompt carries the sources, what earlier stages
decided and the schema of the answer. Each answer gives its reasoning, the layer, and a provenance entry
for every field: the exact words of a source, or what the value was inferred from. The code checks the
answer (schema, universal rules, quotes really in their source, numbers that can move, no web page as
the origin of identity, character or limits) and sends the exact problems back, up to two times. If a
stage still fails, `create` stops and names the stage and the problems; nothing is written.

Then four gates must pass before writing: five-state validate = PASS, lint, a first compile, and the
load-bearing check (no mutable coordinate whose value cannot change the compiled document; run it on any
persona with [`personaxis jacobian`](./jacobian.md)). Exit codes follow the validator convention.

## The interview

In a terminal, after reading the sources, a model asks about what they leave open: at most five questions
a round and fifteen in all, written for this job, each with a line saying what is missing. It asks about
real work (a case, a rejected change, what good output looks like), never for ratings, and stops when the
rest can be inferred. Pick an option, type your own answer, `s` skips, `←` goes back, Esc leaves. What you
skip is inferred, and the report lists every question and whether you answered it.

The answers become one source the model reads and cites. They are saved as you give them: leaving part-way
does not lose them, and the next run over the same sources offers to continue. The draft is deleted once
the persona exists. `--yes` and `--json` never ask.

## The coding agent as the model

With `--provider agent`, each stage's prompt is written to `.personaxis/.tmp/<hash>.prompt.md` and
`create` stops (exit 0). The agent running the command (Claude Code, Codex) answers it in
`.personaxis/.tmp/<hash>.out.md`, and re-running the same command replays every answer already written and
stops at the next stage, until the persona exists. The prompts are deterministic, so the hashes match.

## What to review

`creation-report.md` lists the sources, then every field the model **inferred** without a source stating
it, with what it inferred it from: read that list first, and if an inference is wrong, say it in the brief
and create again. Then each stage, with its reasoning, its repairs and each field's origin. Anything
worked around (a web search that returned nothing) is printed when `create` finishes and listed under
**Worked around**. See [genesis](../architecture/genesis.md) for the design.

## Starting profiles

Every persona keeps a state that moves inside its ranges as it works and returns to its baseline on its
own. A profile is the stance the model takes on the three things its owner controls:

| Profile | How far it can move | How fast it returns | Lasting changes to how it works |
|---|---|---|---|
| `regulated` | narrow ranges, about half what the work allows | short half-lives | a person approves them |
| `standard` | as wide as the work needs | half-lives that fit how fast the job recovers | under review; identity, character, values and limits need a person |
| `research` | about half again wider | longer half-lives | applied by the persona itself on working layers |

In all three, changes to who the persona is (identity, character, values, self-regulation) need a person,
and the protected floor (the universals, hard limits, governance, permissions) never opens. None of them is
`locked`: that mode is the kill-switch, for an incident or an audit, and `personaxis improve locked` sets it.
