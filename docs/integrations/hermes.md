# Hermes integration (Nous Research)

Hermes reads **`SOUL.md`** as the first section of its system prompt, from `~/.hermes/SOUL.md` or a
per-profile `SOUL.md`. Each Hermes **profile** carries its own `config.yaml`, `.env`, and `SOUL.md`.
Do the [quickstart](./README.md) model-config step first.

## 1. Identity — compile to SOUL.md

```bash
personaxis compile --root --platform hermes       # → .hermes/SOUL.md
personaxis compile <slug> --platform hermes       # → .hermes/agents/<slug>/SOUL.md (sub-persona)
```

Point your Hermes profile at the generated `.hermes/SOUL.md`, or copy it to `~/.hermes/SOUL.md`. It is
the compiled qualitative identity (same spec as `PERSONA.md`, one source → two views). Hermes also
auto-discovers `AGENTS.md`/`CLAUDE.md`, so a `@PERSONA.md` reference there works too.

## 2. Learning — the `agent:end` hook (per turn, on your model)

```bash
personaxis hooks install --host hermes   # → ~/.hermes/hooks/personaxis-observe/{HOOK.yaml, handler.py}
```

Hermes discovers hooks from `~/.hermes/hooks/<name>/` — a `HOOK.yaml` (metadata + an `events` list)
plus a Python `handler.py` exposing `async def handle(event_type, context)` (see Hermes'
`gateway/hooks.py`). The installer subscribes to **`agent:end`, which fires per turn** and carries
platform/user/session ids plus the message and response — so every turn feeds one governed tick on
**your** model via `personaxis observe --stdin`, recompiling `SOUL.md` on drift. Hermes catches
handler errors and our handler is additionally fire-and-forget with a 60s timeout, so a slow tick
never blocks the Hermes pipeline. Hermes reloads `SOUL.md` fresh each message, so a recompile takes
effect immediately — no restart. Remove with `hooks uninstall --host hermes`.

Other events you can add to the `HOOK.yaml` `events:` list if you want coarser signals:
`session:start`, `session:end` (fires on `/new` or `/reset`), `session:reset`, `agent:start`,
`agent:step`, `gateway:startup`, `command:*`.

> Note: older versions of this installer wrote a `hooks.on_session_end` stanza into
> `~/.hermes/config.yaml`. Hermes never read that shape; `hooks install`/`uninstall` now clean it up.

## 3. On-demand tools — MCP (recommended for Hermes)

Register `personaxis-mcp` in your Hermes profile's MCP servers. Same server + tool list as every host —
see [claude-code.md](./claude-code.md) §2.

## Verify

```bash
personaxis observe --observation "the user is building a governed-persona toolchain" --source user --json
```

See also: [README quickstart](./README.md) · [architecture/agent-adoption.md](../architecture/agent-adoption.md).
