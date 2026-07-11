# `personaxis scan`

Cross-harness config scanner, inspect an agent config (Claude Code / Codex / generic) from a
red-team, blue-team, or auditor lens for risky settings.

## Usage
```bash
personaxis scan <path> [--team red|blue|auditor]
```

Detects the config kind and reports findings by severity. Backed by
`packages/core/src/config-scan.ts`; also exposed as the MCP `scan_config` tool and the
`personaxis-scan` bin.
