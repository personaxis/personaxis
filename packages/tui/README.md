# @personaxis/tui

The terminal interface of Personaxis: the Ink components the `personaxis` app is built from
(streaming transcript, command palette, full-screen views, the persona's sigil and aura), and a
standalone live dashboard.

```bash
npx -p @personaxis/tui personaxis-dash --persona .personaxis/personaxis.md
```

The dashboard draws the persona's sigil, seeded from its identity and animated by its live state,
with the envelope bars, the number of recorded moves and the integrity of the memory chain. It
re-reads `state.json` every frame, so it shows changes made by another process (the app, an MCP
host, the HTTP server) as they happen.

| Flag | Effect |
|---|---|
| `--persona <path>` | the persona's `personaxis.md` |
| `--once` | print one frame and exit (also the behaviour in a pipe or CI) |
| `--frames <n>`, `--interval <ms>` | how many frames, and how far apart |

Inside the `personaxis` CLI the same view is `personaxis dash`.

Entry points for building on it: `@personaxis/tui` (dashboard), `/ink`, `/ui`, `/screen`,
`/fullscreen`, `/viewport`, `/prompt`, `/visual`.

MIT licensed.
