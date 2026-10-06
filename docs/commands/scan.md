# `personaxis scan`

Scan agent config files (Claude Code, Codex, generic) for risky settings, excessive permissions
and leaked credentials. Each finding is tagged red, blue or auditor, the pass that found it.

## Usage
```bash
personaxis scan <path...> [--json] [--strict]
```

Detects the config kind and reports findings by severity. The exit code is 0 for a clean scan, 2 for a risky one and 3 for a malicious one. A "suspicious"
finding exits 0 unless you pass `--strict`, which makes it exit 1. `--json` prints the findings as JSON. The same scan is the MCP
`scan_config` tool and the `personaxis-scan` bin.
