# `personaxis onboard`

Load a persona into a coding agent in one command: it checks the config, compiles the persona
to the host's file and installs the end-of-turn learning hook.

```bash
personaxis onboard                       # defaults to claude-code
personaxis onboard --host codex          # AGENTS.md + Codex agent
personaxis onboard --host claude-code -g # hook into the user config, not the project
personaxis onboard --provider local      # provider for the compile step (local | byok | agent)
```

Hosts: `claude-code | codex | openclaw | hermes`. Inside the app, hooks are in `/status`,
Daemons tab.
