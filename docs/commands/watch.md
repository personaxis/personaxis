# `personaxis watch`

Keep a persona's compiled `PERSONA.md` current in the background. This is the optional local
daemon; it complements the per-turn learning done by [hooks](./hooks.md) and
[`observe`](./observe.md). Hooks handle the learning; `watch` handles what a hook does not: a
manual spec edit and a periodic check for a stale `PERSONA.md`. It runs on your configured
compile provider, never the host's model.

## Usage
```bash
personaxis watch                 # run the daemon (Ctrl+C to stop)
personaxis watch --once          # single reconcile pass, then exit (serverless cron / CI)
```

## Flags

| Flag | Meaning |
|---|---|
| `-p, --persona <path>` | Path to `personaxis.md` (default: `<cwd>/.personaxis/personaxis.md`). |
| `-i, --interval <seconds>` | Seconds between stale checks (default `30`, floored at `5`). |
| `--once` | Do a single reconcile pass then exit. |

## What the daemon does

Two loops run until you stop it:

1. Debounced recompile on hand-edit. It watches `personaxis.md` (`fs.watch`); when you edit the
   spec by hand it recompiles `PERSONA.md` (debounced ~800ms, ignoring duplicate fs events).
2. **Stale check.** Every `--interval` seconds it recompiles only if a governed self-edit
   marked `PERSONA.md` stale; otherwise it does nothing.

## `--once` for serverless / CI

`--once` does a single reconcile pass (recompile if a recompile is pending, else report up-to-date) and
exits, the shape you want from a Vercel Cron / CI step where no long-lived process exists. On a
machine that can hold a process (VM, container), run the full daemon instead.

`watch` does not learn from conversations; how it differs from `observe` and `serve` is in
[observe](./observe.md#observe-watch-and-serve).

## In the app

Inside the app, start and stop it from `/status`, Daemons tab. It runs in the background and
stops with `/exit`.

## See also

- [observe.md](./observe.md), the per-turn learning tick.
- [hooks.md](./hooks.md), wire per-turn learning into a host.
- [../architecture/deployment.md](../architecture/deployment.md), daemon vs serverless shapes.

## While it runs

While the daemon runs, `personaxis ps` shows the persona as held, `watching for spec edits`, and
`compiling` while a recompile runs. A crashed daemon drops off by heartbeat age. See
[presence](../architecture/presence.md).
