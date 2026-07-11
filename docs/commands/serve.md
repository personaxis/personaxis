# `personaxis serve`

Expose the living persona over **plain HTTP + `agents.md`** so an external app or agent (that doesn't
speak MCP) can drive it over the network. A **long-running server**: it blocks until stopped.

```bash
personaxis serve --persona ./.personaxis/personaxis.md      # default port 7637
personaxis serve --persona ./.personaxis/personaxis.md --port 8080
curl http://localhost:7637/agents.md                         # discover the endpoints
```

| Flag | Meaning |
|---|---|
| `-p, --persona <path>` | Path to `personaxis.md` / `PERSONA.md` (required). |
| `--port <n>` | Port (default `7637`). |

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

## Not the MCP server

`serve` is **HTTP** (this page). The **MCP** server is a separate binary, `personaxis-mcp` (package
`@personaxis/mcp`), for MCP hosts (Claude Code/Codex/Cursor). See
[integrations/claude-code.md](../integrations/claude-code.md) §2.

## serve vs watch vs observe (they are NOT the same)

| Command | Role | Runs |
|---|---|---|
| [`observe`](./observe.md) | **learns** from ONE observation (one governed tick) | once, then exits |
| [`watch`](./watch.md) | keeps `PERSONA.md` **fresh** by watching the spec file + a drift heartbeat | long-running daemon |
| `serve` | **exposes** the persona over HTTP for external callers | long-running server |

## In the app

Inside the REPL, `/serve [port]` runs it **in the background** (it doesn't block the session);
`/serve stop` (or `/exit`) stops it.
