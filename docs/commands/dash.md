# `personaxis dash`

The pipe/monitor dashboard: sigil, live envelope bars, mutation count and memory-chain
integrity, re-read from `state.json` each frame, so it reflects evolution happening in
ANOTHER process (a REPL session, an MCP host, `serve`, `watch`) in real time.

**Inside the app this is absorbed by `/drift`** (the drift view shows the same live surface
with drill-down; `/dash` remains a hidden alias). The `dash` subcommand and the standalone
`personaxis-dash` bin exist for the cases a view cannot cover:

```bash
personaxis dash --once          # one snapshot, CI/pipe friendly, no screen takeover
personaxis dash                 # live monitor in a second terminal
personaxis-dash --persona .personaxis/personas/cmo/personaxis.md
```

Use it to watch a persona evolve from OUTSIDE its session (second terminal, tmux pane,
dashboards). For everything interactive, prefer the in-app views.
