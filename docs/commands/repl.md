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
| Command | What it does |
|---|---|
| `/help` | List commands. |
| `/persona` | Show the active persona summary. |
| `/state` | Runtime state + envelopes. |
| `/improve [mode]` | View/set self-improvement mode (`locked`/`suggesting`/`autonomous`). |
| `/mode` | Cycle the sandbox posture (also shift+tab). |
| `/evolve <text>` | Run one governed Living-Loop cycle (shows the steps). |
| `/do <task>` | Hand the persona a task (governed Agent Loop). |
| `/memory` | Inspect memory + verify the hash chain. |
| `/audit` | Governance / overseer view. |
| `/goal` | Set / show / clear a standing goal. |
| `/loop` | Run N internal ticks. |
| `/compact` | Compact the conversation context. |
| `/exit` | Leave. |

## UI
A normal-buffer CLI (native scroll/selection): a status bar below the input
(`ctx tokens · reply time · improve:<mode> · sandbox:<posture>`), a scrollable `/` palette,
per-persona reply colors + sigil glyph, a monochrome responsive logo. See
[../architecture/multi-persona.md](../architecture/multi-persona.md).
