# `personaxis mcp`

Manage the MCP servers this persona mounts as TOOLS (client side): your persona can call
external MCP servers during agent turns.

```bash
personaxis mcp add <name> <command> [args...]   # register a stdio MCP server
personaxis mcp add browser npx -g @some/mcp     # -g writes to the global config
personaxis mcp list
personaxis mcp remove <name>
```

Not to be confused with `personaxis-mcp` (the SERVER binary that exposes this persona's 16
tools to hosts like Claude Code / Codex / Cursor). Tool calls from MCP servers pass the same
sandbox/permission gate as every other tool.
