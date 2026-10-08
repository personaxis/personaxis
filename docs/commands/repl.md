# The REPL (`personaxis` with no subcommand)

Enter an interactive session with your persona. Natural-language input both converses and uses
tools (a governed agent loop); `/commands` drive the session; `@address` routes to sub-personas.

## Addressing
- _(plain text)_ → the MAIN persona (the header always says who you are talking to and in
  which project).
- `@cmo …` / `@cmo/legal …` → a (possibly nested) sub-persona; the reply comes from it, in its
  own color. `@all` → the whole tree; `@cmo/all` → cmo's subtree. See
  [../architecture/multi-persona.md](../architecture/multi-persona.md).

## Slash-commands
The `/` palette lists every command (type to filter, ↑/↓ to move, Tab to complete) and
also passes any CLI subcommand through, so everything the tool can do is reachable inside
the session. The main ones:

| Command | What it does |
|---|---|
| `/help` | Commands by category; `/help <query>` filters; `/help moved` maps every retired verb to its new home. |
| `/persona` | Identity (aura + summary), Anatomy (the 10 layers, Enter drills into each), Resources, Sub-personas, **Evolution** (goal · loop · improve · pending edits), Values. |
| `/status` | Session snapshot, live envelopes, self-edits, **Config** matrix, **Usage** (spend, context, per model) and **Daemons** (serve/watch). |
| `/drift` | How far the persona sits from its baseline, on three planes: continuous (u-space), structural (field-by-field vs the spec) and behavioural (does it move the compiled document). |
| `/audit` | The Ledger: Timeline (with **rewind** as an action), Integrity (chain + replay), Self-edits, Evaluations. |
| `/memory` | Two-level browser (kinds → entries; Enter opens your editor, cross-OS) + consolidate/prune/search. |
| `/create [args]` | Genesis (interview, `--from-prompt`, `--from-import`, …). Needs a model; without one it says how to configure it. |
| `/compile` | Recompile the persona into the files your agents read. |
| `/skill` | Skills per persona: add, materialise (`m`), update, remove; `p` switches persona. |
| `/model` | The resolved model, and the provider menu. |
| `/menu` | The Command Center (Ctrl+K): machine › project › persona always visible, Fleet with live instances, `/` to search. |
| `/doctor` | Offline diagnosis, every finding with its fix. `p` switches persona; `/doctor net` adds one provider ping. |
| `/resume` | Session picker ordered by LAST MESSAGE; rebuilds the chosen conversation, work included. |
| `/compact` | Structured compaction with a before/after token report. Auto at ~80%. |
| `/context` | Context usage by category; `/context all` expands the tree. |
| `/sandbox` | Cycle the posture (also shift+tab). |
| `/bg <prompt>` | Run a turn in the background: a real session you can continue. |
| `/exit` | Leave (daemons stop with you). |

## Verbs that were absorbed

Twenty-three older commands are now tabs and actions inside the ones above. Typing an old name
says where it went and how to reach it from a shell.

```
/cost is now part of /status → Usage
outside the REPL: personaxis status
```

`/help moved` prints the whole map.

Where the notable ones live now:

| Was | Now | Outside the REPL |
|---|---|---|
| `/cost` `/usage` | `/status` → Usage | `personaxis status` |
| `/state` `/config` | `/status` | `personaxis status` / `config` |
| `/validate` `/lint` | `/doctor` | `personaxis validate` / `lint` |
| `/goal` `/loop` `/improve` `/review` | `/persona` → Evolution | `personaxis goal <text>` / `observe` / `improve` / `review` |
| `/rewind` `/replay` | `/audit` | `personaxis state rewind` |
| `/serve` `/watch` `/hooks` | `/status` → Daemons | `personaxis serve` / `watch` / `hooks` |
| `/overseer` | `/menu` → all projects | `personaxis overseer show` |
| `/sessions` | `/resume` | `personaxis --continue`, `personaxis --resume <id>` |
| `/mode` | `/sandbox` | `personaxis config` |
| `/init` | `/create` | `personaxis create` |

> No `/do` (plain chat already uses tools) and no `/evolve` (every turn already runs a
> governed Living-Loop tick). `/dash` points to `/drift`; the standalone monitor is
> `personaxis dash` (see [dash.md](./dash.md)).

While a view is open the text input is unfocused and the view owns the keys; Esc walks back
(drill → list → chat). Views clip every line to the terminal width (ANSI-aware) and rows are
selectable with ↑/↓ + Enter. The `/` palette launches everything.

## UI
A persistent header (wordmark · persona name and main/@sub role · project · sandbox posture)
sits above a native-scroll transcript, so WHERE you are is always on screen. Below the input
a live status bar shows context tokens, reply time, improve mode and a compact gauge of each
layer's distance from its baseline against its declared threshold (red when a layer exceeds
it). The gauge reads the same numbers as [`state drift --json`](./drift.md). The persona's aura
(a small animated creature generated from its spec, see [sigil.md](./sigil.md)) appears at
startup and in `/persona`.

When a tick moves a coordinate into a new behavior band, the live region shows the old and new
band and the evidence cost paid (the count of chained mutation-log entries), then commits a
one-line summary to the transcript. Set `PERSONAXIS_NO_ANIM=1` to skip straight to the summary
(deterministic for CI).

Degradation is intact: `NO_COLOR`/ASCII, and pipe/CI (non-TTY) drops full-screen for plain
line mode with the reports inline, printing the SAME collector text the views render (one
source of truth per surface). See
[../architecture/multi-persona.md](../architecture/multi-persona.md).
