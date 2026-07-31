# Using personaxis from a script or an agent

A coding agent cannot drive a menu. Everything the interactive session can do therefore
either has a **non-interactive subcommand**, or is honestly declared as belonging to a live
conversation. This page is generated from the command table itself, and a test verifies
that every gate below names a subcommand that really exists, so it cannot drift from the
code.

Every inspection subcommand takes `--json` (machine-readable) and `-p <path>` (which
persona), and persona discovery walks up like git: run one in a directory with no persona
and it answers about the nearest ancestor's, saying so on stderr.

```bash
personaxis status --json                  # what the persona is right now
personaxis drift --json                   # how far it moved, three planes
personaxis audit --tab Integrity --json   # the evidence
personaxis doctor --json                  # health; exit 1 on failure, drops into CI
personaxis review approve <id>            # decide a governed self-edit
```

## The parity table

| In the session | Outside (agents, CI) | What it does |
|---|---|---|
| `/arbitrate` | `personaxis arbitrate` | which declared value WINS when two collide, and why: /arbitrate <a> <b>, or no args for the ranking |
| `/audit` | `personaxis audit` | the evidence: every mutation, the tamper-evident chain, self-edits, and the rewind |
| `/compile` | `personaxis compile` | rebuild the persona document your agents read, from the (evolved) spec |
| `/config` | `personaxis config` | the Settings miniapp on its Config tab: effective configuration and where each value comes from |
| `/create` | `personaxis create` | create or rewrite a persona: interview, a prompt, an import, a transcript |
| `/dash` | `personaxis dash` | the living dashboard: in-app drift view (↑/↓ · Enter · Esc), inline frame in pipes |
| `/doctor` | `personaxis doctor` | is anything wrong? config, spec, lint, integrity, provider, with a fix for each finding |
| `/drift` | `personaxis state drift` | how far the persona has moved from what it declared, and in what |
| `/goal` | `personaxis goal` | the persona's standing objective: /goal <text> sets it, /goal shows it, /goal clear removes it |
| `/hooks` | `personaxis hooks` | the hooks submenu (status + install/uninstall per host); /hooks <host> [global] installs directly |
| `/improve` | `personaxis improve` | view/set self-improvement mode: locked | suggesting | autonomous (menu with arrows) |
| `/init` | `personaxis init` | alias: quick template scaffold for a sub-persona; /create is the full Genesis (interview, imports, provenance) |
| `/lint` | `personaxis lint` | lint this persona's spec (tier-aware findings) |
| `/loop` | `personaxis observe` | run n governed Living-Loop ticks (observe→appraise→govern→evolve→recompile→memory) |
| `/memory` | `personaxis memory` | what it remembers, by kind, and what to do with it |
| `/menu` | `personaxis menu` | the Command Center: this project or every project, with live state |
| `/model` | `personaxis model` | which model answers, for this persona or any other |
| `/overseer` | `personaxis overseer` | the cross-project registry: every persona/project this machine knows (optional infra) |
| `/persona` | `personaxis list` | who this persona is: identity, the ten layers, its resources, its sub-personas, how it evolves |
| `/proof` | `personaxis proof` | run the live guarantee scenes full-screen inside the app |
| `/replay` | `personaxis audit --verify` | alias of /rewind's timeline (the mutation history); in pipes it replays the log inline (T4) |
| `/review` | `personaxis review` | review queued self-edits in a list (a/r per item); /review [approve|reject] <id|all> works too |
| `/rewind` | `personaxis state rewind` | the state-history timeline: pick a point, preview what restores, confirm; /rewind <n> undoes directly |
| `/serve` | `personaxis serve` | start/stop the HTTP server in the background: /serve [port] · /serve stop |
| `/skill` | `personaxis skills` | the reusable procedures this persona can run: add, update, apply |
| `/state` | `personaxis state` | live mutable surface: envelopes + applied self-edits + pending proposals (Settings > Status) |
| `/status` | `personaxis status` | this session at a glance: state, config, spend, stats, daemons and background tasks |
| `/validate` | `personaxis validate` | validate this persona's spec against the schema + universals |
| `/watch` | `personaxis watch` | start/stop the freshness daemon in the background: /watch · /watch stop |


| Session-only | Why there is nothing to expose |
|---|---|
| `/bg` | starts a background task owned by the running session; outside, run the command directly |
| `/compact` | summarizes the CURRENT conversation history; there is no history outside a session |
| `/context` | reports the live context window of the running conversation |
| `/cost` | hidden alias of /usage |
| `/exit` | ends a running conversation; a one-shot command ends on its own |
| `/help` | lists the slash commands of a running session; outside, `personaxis --help` is the equivalent |
| `/mode` | hidden alias of /sandbox |
| `/quit` | hidden alias of /exit; it ends a running conversation and nothing else |
| `/resume` | loads a saved conversation into the running REPL; a one-shot command has no conversation to load it into |
| `/sandbox` | the sandbox posture belongs to a terminal; a one-shot run is governed by its own flags |
| `/sessions` | an alias of /resume, which loads a conversation into the running REPL |
| `/tasks` | lists the background tasks of the running session |
| `/usage` | reports THIS sessions spend and tokens; there is no session outside one |
