# `personaxis hooks`

Wire a host so the persona **learns from every turn**. The living engine can't see inside the host's
process — the host has to feed it. `hooks install` adds a hook that pipes each turn to
[`personaxis observe --stdin`](./observe.md), which runs one governed tick on **your** configured
model and recompiles `PERSONA.md` on drift — learning **without spending the host's tokens**.

## Usage
```bash
personaxis hooks install --host claude-code   # or: codex | openclaw | hermes
personaxis hooks install --host codex --global
personaxis hooks uninstall --host <host>
```

## `install` — all four focus hosts

Each host fires an end-of-turn (or end-of-session) hook that runs `personaxis observe --stdin --source
user`. `observe --stdin` understands each host's payload (Claude Code's `transcript_path`, Codex's
`last_assistant_message`, openclaw's event `context`).

| Host | What it writes | Event |
|---|---|---|
| `claude-code` | `.claude/settings.json` (or `~/.claude` with `--global`) | `Stop` |
| `codex` | `.codex/hooks.json` (or `~/.codex` with `--global`) | `Stop` |
| `hermes` | `~/.hermes/config.yaml` → `hooks.on_session_end` | per session |
| `openclaw` | `~/.openclaw/hooks/personaxis-observe/{HOOK.md,handler.ts}` — then `openclaw hooks enable personaxis-observe` | `command:stop` |

| Flag | Meaning |
|---|---|
| `--host <host>` | `claude-code \| codex \| openclaw \| hermes`. |
| `-g, --global` | Write to the user config instead of the project (claude-code/codex; hermes/openclaw are always user-scoped). |

It is **idempotent**: install merges without clobbering other hooks and does nothing if ours is present.

> **Hermes** fires `on_session_end` (once per session, not per turn) — for on-demand, per-tool access
> also register the MCP server. For **serverless**, skip hooks and run `personaxis observe --once` from
> a cron.

## `uninstall`

Removes **only** the personaxis hook (matched by the `personaxis observe` marker) for the given host,
leaving any other hooks intact. Same `--host` / `--global` flags.

## See also

- [observe.md](./observe.md) — the tick this hook fires each turn.
- [watch.md](./watch.md) — idle / manual-edit recompiles.
- [../architecture/deployment.md](../architecture/deployment.md) — the hook-vs-MCP-vs-watch picture.
