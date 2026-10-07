# `personaxis create`: Genesis

Create a persona from what you have. A model writes it one layer at a time from your sources, and the
code checks every answer before it is kept. Every way in produces the same four files: a validated
`personaxis.md`, `state.json`, a first compiled `PERSONA.md`, and `creation-report.md`, which records
where each field came from.

A model is required. Without one, `create` refuses, says how to configure one, and writes nothing.

A persona is the whole way a professional works: procedures, criteria, tools, sourced knowledge and
character. The interview mostly fills in character; `--research` adds sourced knowledge (see below).

```bash
personaxis create                              # asks WHICH source to use (TTY)
personaxis create --deep                       # the full 20-question interview
personaxis create --from-prompt "<brief>"      # natural language
personaxis create --from-project [dir]         # the project's own docs
personaxis create --from-import card.png       # character card V2/V3 (.json/.png)
personaxis create --from-import CLAUDE.md      # system prompt, CLAUDE.md, AGENTS.md, SOUL.md
personaxis create --research                   # also search the web and keep the sources
personaxis create --from-transcript chat.txt   # exemplar conversations
```

Sources **compose**: each one is numbered (S1, S2, ...) and the model reads them together. `[slug]` names
the persona (default: under `.personaxis/personas/<slug>/`; `--root` writes the project's root persona).

| Flag | Effect |
|---|---|
| `--deep` | ask the FULL question bank (20) instead of the 12 core questions |
| `--profile <name>` | starting profile, `regulated`, `standard` (default) or `research`: see below |
| `--yes` | never ask, and overwrite existing files |
| `--json` | emit spec + gates + notes + sources + stages as JSON on stdout (dry-run unless `--yes`) |
| `--provider <p>` | override the provider (`local\|byok\|agent`) |
| `--research` | search the web for the field and keep what it found in `references/`, with each source and its date (needs a web provider key, see [web](./web.md)) |
| `--no-polish` | skip the model polish of `PERSONA.md` after creation; the template is marked pending |
| `--root` | create the project's root persona |

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

Running `create` with no `--from-*` flag opens on the six ways to build a persona, so the sources are
visible rather than hidden in `--help`. Passing any flag skips that screen, which is what scripts and
agents do.

| Interview | Questions | Asks about |
|---|---|---|
| default | **12** | who it is, the five trait axes, values, voice, what it must never do |
| `--deep` | **20** | the above plus envelope width, mood half-life, refusal detail, uncertainty thresholds, memory policy, starting profile, a voice exemplar |

The answers become one source the model reads and cites. Answers are saved as you give them: leaving the
interview part-way does not lose them, and the next run offers to continue. The draft is deleted once the
persona exists.

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
