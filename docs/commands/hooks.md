# `personaxis hooks`

Wire a host so the persona learns from every turn. The engine cannot see inside the host's
process, so the host feeds it. `hooks install` adds a hook that pipes each turn to
[`personaxis observe --stdin`](./observe.md), which runs one governed tick on your configured
model and recompiles `PERSONA.md` when the tick leaves it stale. The tick runs on your model,
so it does not spend the host's tokens.

Hooks and `compile --platform` are the two ways to load a persona into a host: compile writes
what the host reads, hooks feed the host's turns back to the persona.

## Usage
```bash
personaxis hooks install --host claude-code   # or: codex | openclaw | hermes
personaxis hooks install --host codex --global
personaxis hooks uninstall --host <host>
```

## `install`, all four focus hosts

Each host fires an end-of-turn (or end-of-session) hook that runs `personaxis observe --stdin`.
`observe --stdin` understands each host's payload (Claude Code's `transcript_path`, Codex's
`last_user_message` and `last_assistant_message`, openclaw's event `context`), and decides from it
who spoke: the person's message is recorded as `user`, anything else as `internal`
([observe](./observe.md)).

| Host | What it writes | Event |
|---|---|---|
| `claude-code` | `.claude/settings.json` (or `~/.claude` with `--global`) | `Stop` |
| `codex` | `.codex/hooks.json` (or `~/.codex` with `--global`) | `Stop` |
| `hermes` | `~/.hermes/hooks/personaxis-observe/{HOOK.yaml,handler.py}` | `agent:end`, every turn |
| `openclaw` | `~/.openclaw/hooks/personaxis-observe/{HOOK.md,handler.ts}`, then `openclaw hooks enable personaxis-observe` | `command:stop` |

| Flag | Meaning |
|---|---|
| `--host <host>` | `claude-code \| codex \| openclaw \| hermes`. |
| `-g, --global` | Write to the user config instead of the project (claude-code/codex; hermes/openclaw are always user-scoped). |

It is **idempotent**: install merges without clobbering other hooks and does nothing if ours is present.

For on-demand, per-tool access, also register the MCP server (see [mcp](./mcp.md#as-a-server)).
For serverless setups, skip hooks and run `personaxis observe --observation ...` from a cron.

## `check`

`personaxis hooks check` reports any installed enforcement hook the host cannot run, so calls
would go ungated. The exit code is 1 if one is broken.

## `uninstall`

Removes **only** the personaxis hook (matched by the `personaxis observe` marker) for the given host,
leaving any other hooks intact. Same `--host` / `--global` flags.

## See also

- [observe.md](./observe.md), the tick this hook fires each turn.
- [watch.md](./watch.md), idle / manual-edit recompiles.
- [../architecture/deployment.md](../architecture/deployment.md), the hook-vs-MCP-vs-watch picture.
