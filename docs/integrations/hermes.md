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

## 2. Learning — the on_session_end hook (on your model)

```bash
personaxis hooks install --host hermes            # → ~/.hermes/config.yaml (hooks.on_session_end)
```

Hermes fires `on_session_end`, so this runs `personaxis observe --stdin` **once per session** (not per
turn — Hermes doesn't expose a per-turn event carrying the conversation). It runs a governed tick on
**your** model and recompiles `SOUL.md` on drift. Remove it with `hooks uninstall --host hermes`.

> For *per-turn* / on-demand learning on Hermes, use the **MCP server** (Hermes supports MCP servers
> per profile): the agent calls `persona_observe`/`persona_state`/… when it chooses to.

## 3. On-demand tools — MCP (recommended for Hermes)

Register `personaxis-mcp` in your Hermes profile's MCP servers. Same server + tool list as every host —
see [claude-code.md](./claude-code.md) §2.

## Verify

```bash
personaxis observe --observation "the user is building a governed-persona toolchain" --source user --json
```

See also: [README quickstart](./README.md) · [architecture/agent-adoption.md](../architecture/agent-adoption.md).
