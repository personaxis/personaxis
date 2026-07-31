# `personaxis onboard`

Wire a coding-agent host end to end in one command: config check, compile to the host's
file, and the end-of-turn learning hook.

```bash
personaxis onboard                       # defaults to claude-code
personaxis onboard --host codex          # AGENTS.md + Codex agent
personaxis onboard --host claude-code -g # hook into the user config, not the project
```

Hosts: `claude-code | codex | openclaw | hermes`. Equivalent inside the app: `/hooks` (the
submenu shows per-host install status and what each hook does before installing).
