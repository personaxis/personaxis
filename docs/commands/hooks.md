# `personaxis hooks`

Wire a host so the persona **learns from every turn**. The living engine can't see inside the host's
process — the host has to feed it. `hooks install` adds a hook that pipes each turn to
[`personaxis observe --stdin`](./observe.md), which runs one governed tick on **your** configured
model and recompiles `PERSONA.md` on drift — learning **without spending the host's tokens**.

## Usage
```bash
personaxis hooks install --host claude-code           # project (.claude/settings.json)
personaxis hooks install --host claude-code --global  # user (~/.claude/settings.json)
personaxis hooks uninstall --host claude-code
```

## `install`

Writes a Claude Code **`Stop`** hook that runs `personaxis observe --stdin --source user` at the end
of every turn.

| Flag | Meaning |
|---|---|
| `--host <host>` | Host to wire (currently only `claude-code`). |
| `-g, --global` | Write to `~/.claude/settings.json` instead of the project `.claude/settings.json`. |

It is **idempotent**: install merges our hook into the existing `Stop` list without clobbering other
hooks, and does nothing if ours is already present.

## `uninstall`

Removes **only** the personaxis hook (matched by the `personaxis observe` command marker), leaving any
other `Stop` hooks intact. Same `--host` / `--global` flags.

## Other hosts

There is **no per-turn hook for Codex or other hosts yet**. `install --host <other>` exits with a
pointer to the two alternatives: the MCP server ([`personaxis serve`](./serve.md), which the agent
calls on-demand) or a serverless cron running [`personaxis observe --once`](./observe.md).

## See also

- [observe.md](./observe.md) — the tick this hook fires each turn.
- [watch.md](./watch.md) — idle / manual-edit recompiles.
- [../architecture/deployment.md](../architecture/deployment.md) — the hook-vs-MCP-vs-watch picture.
