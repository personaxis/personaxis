# Commands

The CLI creates, compiles and loads personas. `create` builds one, `compile --platform` and
`hooks install` load it into Claude Code, Codex, OpenClaw or Hermes, and `personaxis-mcp` serves it
to any MCP host.

There are two ways in: `personaxis <command>` from a shell, and slash commands inside the
interactive session. Commands with their own page are linked below.

## Build and check a persona

| Command | What it does |
|---|---|
| [`create [slug]`](./create.md) | Build a persona from an interview, a prompt (`--from-prompt`), a project (`--from-project`), an import (`--from-import`: character cards V2/V3, SOUL.md, system prompts, CLAUDE.md or AGENTS.md) or a transcript (`--from-transcript`). `--research` keeps sourced web references. The result passes validation and ships with a creation report that says where each number came from. |
| [`init`](./init.md) | Scaffold a persona from the commented template. `--agent` makes an agent persona, `--user` a user persona, `-f` overwrites. Use `create` to build one from evidence. |
| [`template`](./template.md) | `list`, `show` and `get` the authoring templates. |
| [`validate [file]`](./validate.md) | Five-status validator (PASS, PASS_WITH_WARNINGS, FAIL_SCHEMA, FAIL_POLICY, FAIL_CONCEPTUAL); `--all` checks the root and every sub-persona. |
| [`lint [file]`](./lint.md) | Tier-aware semantic findings against the layer and field contract (`--format json`). |
| [`edit <dot-path> <value>`](./edit.md) | Governed edit of one spec value; re-validates and refuses any edit that would break a universal. |
| [`migrate <a-to-b>`](./migrate.md) | Version codemods (`0.10-to-1.0` is the breaking one, comment-preserving; earlier bumps are additive). |
| [`spec`](./spec.md) | Print the `personaxis.md` spec (v1.1) and the lint rules, ready to inject into an agent's prompt. |
| [`list`](./list.md) | Installed personas. |
| [`personas`](./personas.md) | The global persona registry: `list`, `import`, `export`, `adopt`. |
| [`skills`](./skills.md) | `list` and `pull` the skills a persona declares, with a security review. |
| [`web search <query>`](./web.md) | Search the web with the configured provider, the same search a persona's `web_search` tool runs. |

## Compile and load into an agent

| Command | What it does |
|---|---|
| [`compile [slug]`](./compile.md) | Compile `personaxis.md` into `PERSONA.md`; a model writes it, held to the definition; `--platform` writes it where Claude Code, Codex, OpenClaw or Hermes read it. |
| [`decompile`](./decompile.md) | Fold a hand-edited `PERSONA.md` back into a proposed `personaxis.md` (re-validates before writing). |
| [`export`](./export.md) | Export the compiled document to JSON, YAML or Markdown (`--format` is required). |
| [`diff <a> <b>`](./diff.md) | Field-by-field diff of two `PERSONA.md` files; exits 1 on a breaking change. |
| [`onboard`](./onboard.md) | Load a persona into a host in one command: config check, compile and the learning hook. |
| [`hooks`](./hooks.md) | `install`, `uninstall` and `check` the end-of-turn hook that feeds `observe`. |
| [`observe`](./observe.md) | Feed one observation: one governed tick on your model, then recompile if the document is stale (`--stdin` for host hooks). |
| [`watch`](./watch.md) | Optional local daemon: recompile on hand edits and check periodically for a stale `PERSONA.md` (`--once` for cron or CI). |
| [`serve`](./serve.md) | Serve a persona over HTTP plus `agents.md` for apps that do not speak MCP (`--host`, `--token`). |
| [`mcp`](./mcp.md) | Manage the MCP servers a persona mounts as tools, and the tools `personaxis-mcp` serves to hosts. |
| [`guard`](./guard.md) | Enforce the persona's policy on Claude Code and Codex before each tool call, on this machine only. |

## Configure the model

| Command | What it does |
|---|---|
| [`config`](./config.md) | `set`, `get`, `show` and `use` configuration values (global or project). |
| [`model`](./model.md) | Show the resolved model for the main persona and every sub-persona, or `model set`. |
| [`credential`](./credential.md) | Store API keys in the OS secure store (`set`, `get`). |

## Inspect a running persona

| Command | What it does |
|---|---|
| [`status`](./status.md) | One-screen snapshot of a persona (`--json`). |
| [`audit`](./audit.md) | Mutation timeline, memory-chain integrity, self-edits and evaluations (`--tab`, `--json`). |
| [`memory`](./memory.md) | What a persona remembers, by kind (`--json`). |
| [`state`](./state.md) | `init`, `show`, `mutate`, `rewind`, `rebuild` and `drift` for `state.json`. |
| [`state drift`](./drift.md) | How far each coordinate sits from its baseline, with the evidence cost to the next band. Exits 2 past a threshold. |
| [`goal`](./goal.md) | Set, show or clear the persona's standing goal. |
| [`improve [mode]`](./improve.md) | View or set the self-improvement posture (`locked`, `suggesting`, `autonomous`). |
| [`review`](./review.md) | Approve or reject queued self-edit proposals. |
| [`doctor`](./doctor.md) | Offline health check where every finding comes with its fix (`--net`, `--json`). |
| [`proof`](./proof.md) | Run a self-check of the engine on a throwaway copy of the active persona (or the embedded one with `--demo`): hostile input, tamper detection, replay. |
| [`trace <file>`](./trace.md) | Render a `trace-*.jsonl` file as a timeline. |
| [`scan`](./scan.md) | Scan agent config files (Claude Code, Codex, generic) for risky settings and leaked credentials (`--json`, `--strict`). |
| [`sync`](./sync.md) | Reconcile a persona's state across machines. |
| [`ps`](./ps.md) | Fleet view for this project: who is holding each persona, mutation counts, tone, last change. |
| [`card`](./card.md) | Print a shareable card for a persona. |

## Work across personas and services

| Command | What it does |
|---|---|
| [`service run <address>`](./service.md) | Run a service locally: numbered steps done by personas or by other services, with approvals asked in the terminal and a journal next to the work. `--check` validates the composition only; `--json` prints one object. |
| [`service resume <journal>`](./service.md#picking-a-waiting-run-up) | Pick up a run that waits for an approval or an answer (`--answer`, `--approve`, `--reject`). |
| [`team`](./team.md) | Teams: a lead, members with roles and a shared goal. |
| [`overseer`](./overseer.md) | Optional local registry of personas, projects and collections. |
| [`orchestrate <task>`](./orchestrate.md) | Route a task to the best-matched registered persona. |
| [`lease`](./lease.md) | Optional exclusive write lease, for when you would rather serialize than merge. |

## Visual and integrity tools

| Command | What it does |
|---|---|
| [`menu`](./menu.md) | The Command Center (`--classic`, `--section`). |
| [`console`](./console.md) | Headless access to the Command Center tree (`ls`, `get`, `do`) for agents and CI. |
| [`sigil`](./sigil.md) | Render a persona's sigil, the deterministic glyph generated from its spec. |
| [`dash`](./dash.md) | Live dashboard of a persona's envelopes and memory chain. |
| [`jacobian`](./jacobian.md) | Which numbers change the compiled document; flags decorative ones (exit 2). |
| [`arbitrate [a] [b]`](./arbitrate.md) | Deterministic value-conflict resolution with an explanatory trace. |
| [`sign` / `verify` / `attest`](./attest.md) | A local integrity record of the spec, its check, and a behavioral credential with an expiry. |

Running `personaxis` with no subcommand opens the [interactive session](./repl.md).
[`parity`](./parity.md) maps each capability in the session to its command for scripts.

## Slash commands in the session

Inside the session, the larger commands open full-height views with tabs and arrow navigation
(Esc returns). In pipes and CI every command prints the same data as plain text.

| Command | What it does |
|---|---|
| `/help` | Commands by category; `/help <q>` filters; `/help moved` maps every older command to its home. |
| `/persona` | Identity (with the aura), Anatomy (the ten layers), Resources, Sub-personas, Evolution (goal, loop, improve, pending edits) and Values. |
| `/status` | Session snapshot, live envelopes, self-edits, a Config matrix, Usage (spend, per model) and Daemons. |
| `/drift` | Three planes: continuous (u-space), structural (field by field against the spec) and behavioral (does it move the compiled document). |
| `/audit` | Timeline (rewind is an action here), Integrity (chain and replay), Self-edits, Evaluations. |
| `/memory` | Kinds, then entries; Enter opens the file in your editor; consolidate, prune, search. |
| `/create [args]` | Genesis (interview, `--from-prompt`, `--from-import`, ...); needs a model, which also writes its PERSONA.md. |
| `/compile` | Recompile the files your agents read, from the evolved spec. |
| `/skill` | Skills per persona: add, materialize (`m`), update, remove, apply; `p` switches persona. |
| `/model` | The resolved model and the provider menu. |
| `/menu` | The Command Center: `machine › project › persona` always visible, Fleet with live instances, `g` scope, `/` search. |
| `/doctor` | Offline diagnosis, every finding with its fix; `p` switches persona; `/doctor net` adds one provider ping. |
| `/resume` | Session picker by last message; rebuilds the conversation including the work each turn did. |
| `/compact` | Structured compaction with a before and after token report. |
| `/context` | Context usage by category; `/context all` expands the tree. |
| `/sandbox` | Cycle the sandbox posture (shift+tab also). |
| `/bg <prompt>` | A turn in the background: a real session you can continue. |
| `/exit` | Leave (daemons stop with you). |

Twenty-three older commands are now tabs or actions inside the ones above. Typing an old name says
where it went and what to run outside the app. `/help moved` prints the map, and the full table is
in [`repl.md`](./repl.md).

Every capability is both a view in the session and a subcommand for agents and CI. Any other CLI
subcommand also works as `/<name>`: the session runs `personaxis <name>` and prints the output
(`/spec`, `/export`, `/decompile`, `/diff`, `/skills`, `/scan`, `/personas`, `/migrate` and so on).
The `serve` and `watch` daemons are started and stopped from `/status`, Daemons tab, and stop with
`/exit`. There is no `/observe`, because the session already runs a governed tick on every turn.

Address sub-personas inline with `@slug ...` or `@all ...`; see
[multi-persona](../architecture/multi-persona.md). The session's behavior is described in
[memory](../architecture/memory.md), [sessions](../architecture/sessions.md),
[self-evolution](../architecture/self-evolution.md), [awareness](../architecture/awareness.md) and
[sandbox](../architecture/sandbox.md).
