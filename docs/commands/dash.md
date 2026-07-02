# `personaxis dash`

The living **ASCII dashboard**: a per-persona view of the sigil (seeded from `personaxis.md`),
the live envelope bars, mutation count, and memory-chain integrity. It re-reads `state.json` every
frame, so it reflects evolution happening in **another process** — a REPL session, an MCP host,
`serve`, or `watch` — in real time.

Shipped two ways from one engine: the `personaxis dash` subcommand and the standalone
`personaxis-dash` bin (package `@personaxis/tui`) behave identically.

## Usage
```bash
personaxis dash                              # interactive: live view until Ctrl+C
personaxis dash -p ./.personaxis/personaxis.md
personaxis dash --once --frames 3            # print a snapshot and exit (CI / piping)
```

## Flags

| Flag | Meaning |
|---|---|
| `-p, --persona <path>` | Path to `personaxis.md` (default: `.personaxis/personaxis.md`). |
| `--once` | Print `--frames` static frames then exit — no screen takeover (for CI / piping). |
| `--frames <n>` | How many frames to print with `--once` (default `30`). |
| `--interval <ms>` | Refresh interval in interactive mode (default `500`). |

## Interactive vs snapshot

- **Interactive** (a TTY, no `--once`): takes over the alternate screen buffer so it never pollutes
  scrollback, and animates until you press `Ctrl+C`.
- **Snapshot** (`--once`, or output piped/non-TTY): prints plain frames and exits — safe for CI.

## In the app

Inside the REPL, `/dash` prints a **single inline snapshot** (the REPL owns the TTY, so it does not
take over the screen). For the animated live view, run `personaxis dash` in a **second terminal**
while the session drives the persona — the dashboard animates as state evolves.

## dash vs the other surfaces

`dash` only **reads** and **renders** — it never mutates the persona. Contrast with the surfaces that
change state:

| Command | Role |
|---|---|
| `dash` | **renders** the live state (read-only view) |
| [`observe`](./observe.md) | **learns** from one observation (governed tick) |
| [`watch`](./watch.md) | keeps `PERSONA.md` **fresh** (recompile daemon) |
| [`serve`](./serve.md) | **exposes** the persona over HTTP |

## See also

- [sigil.md](./sigil.md) — render just the deterministic sigil (no envelopes/memory).
- [../architecture/awareness.md](../architecture/awareness.md) — what the live state reflects.
