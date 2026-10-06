# `personaxis observe`

Feed one observation to the persona: run a single governed tick on your configured model, and
recompile `PERSONA.md` only if the tick left it stale. Host hooks and serverless crons call it so
the persona learns without spending the host's tokens.

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
| `-s, --source <source>` | Provenance: `user` \| `tool` \| `internal` \| `synthesis`. With `--observation` it decides, default `user`. With `--stdin` the payload decides, and this can only lower it. |
| `--json` | Emit the tick report + result as JSON (for programmatic hosts). |
| `--strict` | Exit non-zero if the tick fails (default: never break the host). |

## What it does

1. Resolves the persona spec (explicit `--persona`, else the project root spec).
2. Runs **one** governed tick on the resolved model (`resolveModel`, an `LlmAppraiser` when a model
   is configured, else the offline `HeuristicAppraiser`).
3. **Recompile only when stale:** if the tick applied a governed self-edit that marked
   `PERSONA.md` stale, it recompiles (`--if-pending`, via the `local` provider), so the host
   reads a current document without a recompile on every turn.

## `--stdin` and the Claude Code Stop hook

With `--stdin` the observation comes from a host-hook JSON payload. For Claude Code's `Stop` hook the
payload carries a `transcript_path`; `observe` reads that JSONL and takes **the person's last
message**, recorded with provenance `user` (capped at ~1200 chars). Codex's `last_user_message` and a
`prompt` field are the person's too. The model's reply is not observed when the person's message is
there, the same way the REPL observes the person's line and not the reply: a persona that appraised
its own output would be reacting to itself. When a payload carries only the reply, a `message`, an
event `context`, or raw text, that text is observed with provenance `internal`: it can move the
persona's state, and it cannot justify a self-edit, which needs `user` trust.

## Never breaks the host

By design this is best-effort: a tick failure, an empty payload, or a missing persona is a no-op
that exits `0`, it never fails the surrounding turn. Pass `--strict` to make failures exit non-zero
(for CI, where you *want* the signal). Stdin reads time out after 1.5s so a hook can never hang.

## observe, watch and serve

| Command | Role | Runs |
|---|---|---|
| `observe` | learns from one observation (one governed tick), recompiles when stale | once, then exits |
| [`watch`](./watch.md) | keeps `PERSONA.md` current by watching the spec file and checking periodically for a stale one | long-running daemon |
| [`serve`](./serve.md) | exposes the persona over HTTP for external callers | long-running server |

## See also

- [hooks.md](./hooks.md), install the host Stop hook that calls this every turn (all four hosts).
- [watch.md](./watch.md), the daemon for idle / manual-edit recompiles.
- [../architecture/deployment.md](../architecture/deployment.md), where per-turn learning fits.

## While it runs

While a tick runs, `personaxis ps` shows the persona as held by `observe`. See
[presence](../architecture/presence.md).
