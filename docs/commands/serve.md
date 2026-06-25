# `personaxis serve`

Serve the persona runtime over the **MCP** (Model Context Protocol) stdio server so any host —
Claude Code, Codex, Cursor — can call the persona tools.

## Usage
```bash
personaxis serve            # or run the bin: personaxis-mcp
```

## Tools exposed (selection)
`persona_compiled`, `persona_state`, `adjust_persona_state`, `persona_observe`,
`persona_audit`, `persona_propose_edit`, `persona_recompile_status` (stale signal — the host
runs `personaxis compile` when pending), `scan_config`. See `packages/mcp/`.
