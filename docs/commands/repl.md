# The REPL (`personaxis` with no subcommand)

Enter a living, interactive session with your persona. Natural-language input both converses
AND uses tools (a governed agent loop); `/commands` drive the session; `@address` routes to
sub-personas.

## Addressing
- _(plain text)_ → the ROOT persona.
- `@cmo …` / `@cmo/legal …` → a (possibly nested) sub-persona; the reply comes from it, in its
  own color. `@all` → the whole tree; `@cmo/all` → cmo's subtree. See
  [../architecture/multi-persona.md](../architecture/multi-persona.md).

## Slash-commands
The `/` palette lists every command (type to filter, ↑/↓ to move, Tab to complete) and
also passes any CLI subcommand through, so everything the tool can do is reachable inside
the session. The load-bearing ones:

| Command | What it does |
|---|---|
| `/help` | List commands. |
| `/persona` | Identity, role (root/sub), sub-personas, resources + sigil. |
| `/state` | Runtime state + envelopes. |
| `/drift` | Open the full-height drift view: per-coordinate `u`/band/headroom, the T3 evidence cost to cross, and each layer's `D` against its threshold (↑/↓ select, Enter inspects with a sparkline + audit log, Esc returns). In a pipe it prints the inline report instead. |
| `/dash` | Open the living dashboard as an in-app view (same navigation as `/drift`). In a pipe it prints one inline frame and points at `personaxis dash` for a second terminal. |
| `/audit` | Mutation log + memory-chain integrity, as a view. |
| `/proof` | Run the live guarantee scenes full-screen inside the app (the session suspends to the raw TTY and re-mounts after; the scenes stay in scrollback). |
| `/create [args]` | Run Genesis full-screen (the interview wizard, or `--from-prompt`/`--from-import`/…) without leaving the session. |
| `/replay` | Rebuild state from the audit log and flag any value that disagrees (T4). |
| `/arbitrate` | Show the value arbitration order and the deciding key. |
| `/improve [mode]` | View/set self-improvement mode (`locked`/`suggesting`/`autonomous`). |
| `/review [approve\|reject] <id\|all>` | Review queued qualitative self-edits (see [self-evolution](../architecture/self-evolution.md)). |
| `/mode` | Cycle the sandbox posture (also shift+tab). |
| `/memory` | Inspect memory + verify the hash chain (all six [memory types](../architecture/memory.md)). |
| `/sessions` | List saved conversations (`● live` = current). |
| `/resume <id\|name>` | Resume a saved conversation (see [sessions](../architecture/sessions.md)). |
| `/compact` | Compact the conversation context (auto at ~80%). |
| `/goal` | Set / show / clear a standing goal. |
| `/loop` | Run N internal ticks. |
| `/overseer` | Cross-machine/project registry view (optional infra). |
| `/exit` | Leave. |

> No `/do` (plain chat already uses tools) and no `/evolve` (every turn already runs a
> governed Living-Loop tick). The sigil is shown by `/persona`.

While a view is open the text input is unfocused and the view owns the keys; Esc walks back
(detail → list → chat). The `/` palette still launches everything.

## UI
A persistent header (compact wordmark · persona name · sigil glyph · sandbox posture) sits
above a native-scroll transcript. Below the input a live status bar shows context tokens,
reply time, improve mode, and a **compact drift gauge**: per-layer `D` against its declared
threshold, colored by proximity and turned red when a layer exceeds it. The gauge reads the
same numbers as [`state drift --json`](./drift.md).

**The band-crossing moment.** When a governed tick pushes a coordinate across a behavior
band, the live region stages it: the coordinate pulses, the old band gives way, the new
`expression` prose lands, and the T3 evidence cost paid (the count of chained mutation-log
entries) is shown, then a one-line summary commits to the transcript. Set
`PERSONAXIS_NO_ANIM=1` to skip straight to the summary (deterministic for CI).

Degradation is intact: `NO_COLOR`/ASCII, and pipe/CI (non-TTY) drops full-screen for plain
line mode with the reports inline. See
[../architecture/multi-persona.md](../architecture/multi-persona.md).
