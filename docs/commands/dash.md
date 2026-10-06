# `personaxis dash`

The pipe and monitor dashboard: sigil, live envelope bars, mutation count and memory-chain
integrity, re-read from `state.json` each frame, so it reflects evolution happening in another
process (a REPL session, an MCP host, `serve`, `watch`) as it happens.

Inside the app, the same live surface, with drill-down, is `/drift` (typing `/dash` says so). The
`dash` subcommand and the standalone `personaxis-dash` bin (from `@personaxis/tui`) cover what a
view cannot:

```bash
personaxis dash --once          # one snapshot, CI/pipe friendly, no screen takeover
personaxis dash                 # live monitor in a second terminal
personaxis-dash --persona .personaxis/personas/cmo/personaxis.md
```

| Flag | Effect |
|---|---|
| `-p, --persona <path>` | which persona (default `.personaxis/personaxis.md`) |
| `--once` | print a snapshot and exit |
| `--frames <n>` | how many frames `--once` prints (default 30) |
| `--interval <ms>` | refresh interval in live mode (default 500) |

Use it to watch a persona from outside its session: a second terminal, a tmux pane, a
dashboard.
