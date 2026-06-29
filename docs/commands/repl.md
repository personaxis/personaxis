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
| `/persona` | Identity, role (root/sub), sub-personas, resources + sigil. |
| `/state` | Runtime state + envelopes. |
| `/improve [mode]` | View/set self-improvement mode (`locked`/`suggesting`/`autonomous`). |
| `/review [approve\|reject] <id\|all>` | Review queued qualitative self-edits (see [self-evolution](../architecture/self-evolution.md)). |
| `/mode` | Cycle the sandbox posture (also shift+tab). |
| `/memory` | Inspect memory + verify the hash chain (all six [memory types](../architecture/memory.md)). |
| `/audit` | Mutation log + memory-chain integrity. |
| `/sessions` | List saved conversations (`● live` = current). |
| `/resume <id\|name>` | Resume a saved conversation (see [sessions](../architecture/sessions.md)). |
| `/compact` | Compact the conversation context (auto at ~80%). |
| `/goal` | Set / show / clear a standing goal. |
| `/loop` | Run N internal ticks. |
| `/overseer` | Cross-machine/project registry view (optional infra). |
| `/exit` | Leave. |

> No `/do` (plain chat already uses tools) and no `/evolve` (every turn already runs a
> governed Living-Loop tick). The sigil is shown by `/persona`.

## UI
A normal-buffer CLI (native scroll/selection): a status bar below the input
(`ctx tokens · reply time · improve:<mode> · sandbox:<posture>`), a scrollable `/` palette,
per-persona reply colors + sigil glyph, a monochrome responsive logo. See
[../architecture/multi-persona.md](../architecture/multi-persona.md).
