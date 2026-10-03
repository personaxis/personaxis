# @personaxis/mcp

An MCP server (stdio) that exposes a [personaxis.md](https://github.com/personaxis/persona.md)
persona as tools any MCP host can call: Claude Code, Codex, Cursor. The host brings the model and
the tool loop; the server brings the persona's identity, state, memory and policy, and every change
goes through the same clamp, audit and governance gate as the rest of the engine.

## Register it

Claude Code (`.mcp.json` in the project):

```json
{
  "mcpServers": {
    "personaxis": { "command": "npx", "args": ["-y", "@personaxis/mcp"] }
  }
}
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.personaxis]
command = "npx"
args = ["-y", "@personaxis/mcp"]
```

With `npm i -g @personaxis/mcp` the command is `personaxis-mcp`.

## Tools (16)

| Group | Tools |
|---|---|
| Identity and state | `persona_compiled`, `persona_state`, `persona_envelopes`, `adjust_persona_state` |
| Living loop and memory | `persona_observe`, `persona_audit`, `persona_forget`, `persona_recompile_status` |
| Governed self-edits | `persona_propose_edit`, `persona_proposals`, `persona_decide_edit` |
| Safety | `scan_text`, `evaluate_command`, `scan_config`, `skill_review` |
| Work | `agent_run` (the persona's governed agent loop; needs a configured model) |

Most tools take a `persona` argument: the path to its `personaxis.md`.

## Flags

| Flag | Effect |
|---|---|
| `--root <dir>` | every persona path a client sends is confined to this folder (default: where the server started) |
| `--allow-decide` | enables `persona_decide_edit`; without it a client can propose a self-edit but not approve one |

## Documentation

- [Using it inside Claude Code](https://github.com/personaxis/personaxis/blob/main/docs/integrations/claude-code-mcp.md), with a real session trace
- [The full tool reference](https://github.com/personaxis/personaxis/blob/main/docs/integrations/claude-code.md)
- [The repository](https://github.com/personaxis/personaxis#readme)

MIT licensed.
