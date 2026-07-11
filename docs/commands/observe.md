# `personaxis observe`

Feed **one** observation to the living persona: run a single governed Living-Loop tick on your
configured model, and recompile `PERSONA.md` only if that tick left it stale. This is the primitive
that keeps a persona alive **without spending the host's tokens**: fired by a host hook every turn,
or by a serverless cron.

## Usage
```bash
personaxis observe --observation "<text>"          # explicit observation
personaxis observe --stdin                          # read a host-hook payload from stdin
```

## Flags

| Flag | Meaning |
|---|---|
| `-o, --observation <text>` | What just happened (the turn, user message, tool result, …). |
| `--stdin` | Read the observation from a host-hook payload on stdin. |
| `-p, --persona <path>` | Path to `personaxis.md` (default: `<cwd>/.personaxis/personaxis.md`). |
| `-s, --source <source>` | Provenance: `user` \| `tool` \| `internal` \| `synthesis` (default `user`). |
| `--json` | Emit the tick report + result as JSON (for programmatic hosts). |
| `--strict` | Exit non-zero if the tick fails (default: never break the host). |

## What it does

1. Resolves the persona spec (explicit `--persona`, else the project root spec).
2. Runs **one** governed tick on the resolved model (`resolveModel`, an `LlmAppraiser` when a model
   is configured, else the offline `HeuristicAppraiser`).
3. **Drift-gated recompile:** only if the tick applied a governed self-edit that marked `PERSONA.md`
   stale does it recompile (`--if-pending`, via the `local` provider), so the host reads a fresh
   identity without a recompile every turn.

## `--stdin` and the Claude Code Stop hook

With `--stdin` the observation comes from a host-hook JSON payload. For Claude Code's `Stop` hook the
payload carries a `transcript_path`; `observe` reads that JSONL and extracts the **last user +
assistant exchange** (capped at ~1200 chars). It also accepts a `prompt`/`message` field, or raw text,
so any host that pipes the turn on stdin works.

## Never breaks the host

By design this is **best-effort**: a tick failure, an empty payload, or a missing persona is a no-op
that exits `0`, it never fails the surrounding turn. Pass `--strict` to make failures exit non-zero
(for CI, where you *want* the signal). Stdin reads time out after 1.5s so a hook can never hang.

## observe vs watch vs serve (they are NOT the same)

| Command | Role | Runs |
|---|---|---|
| `observe` | **learns** from ONE observation (one governed tick), recompiles on drift | once, then exits |
| [`watch`](./watch.md) | keeps `PERSONA.md` **fresh** by watching the spec file + a drift heartbeat | long-running daemon |
| [`serve`](./serve.md) | **exposes** the persona over HTTP for external callers | long-running server |

## In the app

The living loop already runs a governed tick **every turn** in the REPL, so there is no `/observe`.
To feed a one-off observation manually, run `personaxis observe --observation "…"` (also works via the
REPL passthrough).

## See also

- [hooks.md](./hooks.md), install the host Stop hook that calls this every turn (all four hosts).
- [watch.md](./watch.md), the daemon for idle / manual-edit recompiles.
- [../architecture/deployment.md](../architecture/deployment.md), where per-turn learning fits.
