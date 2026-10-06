# `personaxis serve`

Serve a persona over plain HTTP plus `agents.md`, so an app or agent that does not speak MCP can
use it. The server runs until you stop it.

```bash
personaxis serve --persona ./.personaxis/personaxis.md      # default port 7637
personaxis serve --persona ./.personaxis/personaxis.md --port 8080
curl http://localhost:7637/agents.md                         # discover the endpoints
```

| Flag | Meaning |
|---|---|
| `-p, --persona <path>` | Path to `personaxis.md` / `PERSONA.md` (required). |
| `--port <n>` | Port (default `7637`). |
| `--host <addr>` | Bind address (default `127.0.0.1`). |
| `--token <t>` | Require `Authorization: Bearer <t>` on every request. Required when `--host` is not local. |

## Endpoints

| Method + path | Does |
|---|---|
| `GET /agents.md` | Human/agent-readable tool contract. |
| `GET /persona/state` | Current envelope values + recent mutations. |
| `GET /persona/audit` | Mutation log + memory-chain integrity + anomalies. |
| `POST /persona/observe` | `{ observation, source }` → one governed tick (uses your configured model). |
| `POST /persona/adjust` | `{ field, delta, reason }` → clamped, audited mutation. |
| `POST /persona/agent` | `{ task }` → governed agent run (needs a configured model). |

Every mutation is clamped + audited; untrusted observations are injection-scanned. Same governed engine
as the REPL/hooks.

## The MCP server

For MCP hosts (Claude Code, Codex, Cursor) use `personaxis-mcp` (package `@personaxis/mcp`)
instead; see [mcp](./mcp.md#as-a-server) and
[the Claude Code integration](../integrations/claude-code.md). How `serve` differs from `observe`
and `watch` is in [observe](./observe.md#observe-watch-and-serve).

## In the app

Inside the app, start and stop it from `/status`, Daemons tab. It runs in the background and
stops with `/exit`.

## While it runs

While `serve` runs, `personaxis ps` and the Command Center show the persona as held by `serve`,
with its address. See [presence](../architecture/presence.md).
