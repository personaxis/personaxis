# openclaw integration

openclaw reads **`SOUL.md`** (workspace root) as the first section of its system prompt at every
session start. See the [quickstart](./README.md) for the model config step first.

## 1. Identity — compile to SOUL.md

```bash
personaxis compile --root --platform openclaw     # → SOUL.md (workspace root)
personaxis compile <slug> --platform openclaw     # → .openclaw/agents/<slug>/SOUL.md (sub-persona)
```

`SOUL.md` is the compiled qualitative identity (the same source as `PERSONA.md`, one spec → two views).
openclaw auto-loads it — no `@`-reference injection needed. (openclaw also reads `AGENTS.md`, so a
`@PERSONA.md` reference there works too if you prefer.)

## 2. Per-turn learning — the internal hook (on your model)

```bash
personaxis hooks install --host openclaw
openclaw hooks enable personaxis-observe
```

This writes `~/.openclaw/hooks/personaxis-observe/{HOOK.md, handler.ts}` bound to the `command:stop`
event. On `/stop`, the handler pipes the turn to `personaxis observe --stdin` — one governed tick on
**your** model, recompiling `SOUL.md` on drift. Remove it with `hooks uninstall --host openclaw`.

> openclaw also has **HEARTBEAT.md** (scheduled, plain-English tasks). You can add a heartbeat entry
> that runs `personaxis observe --once` periodically for idle consolidation, in addition to the hook.

## 3. On-demand tools — MCP (optional)

openclaw can call the `personaxis-mcp` server for persona tools on demand (same server as every host).
See [claude-code.md](./claude-code.md) §2 for the registration + tool list.

## Verify

```bash
personaxis observe --observation "the user prefers concise replies" --source user --json
```

See also: [README quickstart](./README.md) · [architecture/agent-adoption.md](../architecture/agent-adoption.md) (SOUL.md details).
