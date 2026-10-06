# Using personaxis from a script or an agent

A coding agent cannot drive a menu, so each session command has a non-interactive subcommand, or is
listed below as session-only. A test checks that every door below exists and that this page names every
session command that has one.

Every inspection subcommand takes `--json` (machine-readable) and `-p <path>` (which persona), and
persona discovery walks up like git: run one in a directory with no persona and it answers about the
nearest ancestor's, saying so on stderr.

```bash
personaxis status --json                  # what the persona is right now
personaxis drift --json                   # how far each coordinate sits from its baseline
personaxis audit --tab Integrity --json   # the evidence
personaxis doctor --json                  # health; exit 1 on failure, drops into CI
personaxis review approve <id>            # decide a governed self-edit
```

## Session commands and their outside door

| In the session | Outside (agents, CI) | What it does |
|---|---|---|
| `/audit` | `personaxis audit` | the evidence: every mutation, the tamper-evident chain, self-edits, and the rewind |
| `/compile` | `personaxis compile` | rebuild the persona document your agents read, from the evolved spec |
| `/create` | `personaxis create` | create or rewrite a persona: interview, a prompt, an import, a transcript |
| `/doctor` | `personaxis doctor` | is anything wrong? config, spec, lint, integrity, provider, with a fix for each finding |
| `/drift` | `personaxis state drift` | how far the persona has moved from its baseline, and in what |
| `/memory` | `personaxis memory` | what it remembers, by kind |
| `/menu` | `personaxis menu` | the Command Center: this project or every project, with live state |
| `/model` | `personaxis model` | which model answers, for this persona or any other |
| `/persona` | `personaxis list` | the persona: its ten layers, its resources, its sub-personas, how it evolves |
| `/skill` | `personaxis skills` | the reusable procedures this persona can run: add, update, apply |
| `/status` | `personaxis status` | this session at a glance: state, config, spend, stats, daemons and background tasks |

## Session-only commands

| Command | Why there is nothing to expose |
|---|---|
| `/bg` | starts a background task owned by the running session; outside, run the command directly |
| `/compact` | summarizes the current conversation history; there is no history outside a session |
| `/context` | reports the live context window of the running conversation |
| `/exit` | ends a running conversation; a one-shot command ends on its own |
| `/help` | lists the slash commands of a running session; outside, `personaxis --help` is the equivalent |
| `/quit` | an alias of `/exit` |
| `/resume` | loads a saved conversation into the running REPL; outside, `personaxis --continue` and `personaxis --resume <id>` start one |
| `/sandbox` | the sandbox posture belongs to a terminal; a one-shot run is governed by its own flags |

## Older commands that moved

Twenty-three older slash commands are now tabs or actions inside the ones above. Typing one prints where
it went; `/help moved` prints the full map. The door from a shell:

| Older command | Now in the session | Outside |
|---|---|---|
| `/arbitrate` | `/persona`, Values tab | `personaxis arbitrate` |
| `/config` | `/status`, Config tab | `personaxis config` |
| `/cost`, `/usage` | `/status`, Usage tab | `personaxis status` |
| `/dash` | `/drift` | `personaxis dash` |
| `/goal`, `/improve` | `/persona`, Evolution tab | `personaxis goal <text>`, `personaxis improve <mode>` |
| `/hooks`, `/serve`, `/watch` | `/status`, Daemons tab | `personaxis hooks`, `personaxis serve`, `personaxis watch` |
| `/init` | `/create` | `personaxis create` |
| `/lint`, `/validate` | `/doctor` | `personaxis lint`, `personaxis validate` |
| `/loop` | `/persona`, Evolution tab | `personaxis observe` |
| `/mode` | `/sandbox` | `personaxis config` |
| `/overseer` | `/menu`, All my projects | `personaxis overseer show` |
| `/proof` | `/doctor`, Proof tab | `personaxis proof` |
| `/replay` | `/audit`, Integrity tab | `personaxis audit --tab Integrity` |
| `/review` | `/persona`, Evolution tab | `personaxis review` |
| `/rewind` | `/audit`, Timeline tab | `personaxis state rewind <n>` |
| `/sessions` | `/resume` | `personaxis --continue`, `personaxis --resume <id>` |
| `/state` | `/status` | `personaxis state show` |
| `/tasks` | `/bg`, `/status` | `personaxis status` |
