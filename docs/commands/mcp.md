# `personaxis mcp`

Manage the MCP servers this persona mounts as TOOLS (client side): your persona can call
external MCP servers during agent turns.

```bash
personaxis mcp add <name> <command> [args...]   # register a stdio MCP server
personaxis mcp add browser npx -g @some/mcp     # -g writes to the global config
personaxis mcp list                             # alias: ls
personaxis mcp remove <name>                    # alias: rm
personaxis mcp approve [name]                   # record a registered server's declaration as approved
```

`mcp add` already records the approval, because adding a server by hand is the consent.
`mcp approve` is for a server registered before approvals existed: it does not mount until
someone approves it. Tool calls from MCP servers pass the same sandbox and permission gate as
every other tool.

## As a server

`personaxis-mcp` is the other direction: a server that exposes this persona to Claude Code,
Codex, Cursor or any MCP host, so the host works the way the persona works. It mounts 16
tools:

| Group | Tools |
|---|---|
| Read the persona | `persona_compiled`, `persona_state`, `persona_envelopes`, `persona_audit`, `persona_recompile_status` |
| Teach it | `persona_observe`, `adjust_persona_state`, `persona_forget` |
| Self-edits | `persona_propose_edit`, `persona_proposals`, `persona_decide_edit` |
| Safety checks | `skill_review`, `scan_text`, `evaluate_command`, `scan_config` |
| Run | `agent_run` |

See [the Claude Code integration](../integrations/claude-code-mcp.md) for how to register it.
