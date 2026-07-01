# `personaxis watch`

Keep a persona's compiled `PERSONA.md` fresh in the background. This is the **optional** local daemon;
it complements the per-turn learning done by [hooks](./hooks.md) / [`observe`](./observe.md). Hooks
handle the learning; `watch` handles the two things a hook doesn't: a **manual spec edit** and an
**idle drift heartbeat**. It runs on your configured compile provider, never the host's model.

## Usage
```bash
personaxis watch                 # run the daemon (Ctrl+C to stop)
personaxis watch --once          # single reconcile pass, then exit (serverless cron / CI)
```

## Flags

| Flag | Meaning |
|---|---|
| `-p, --persona <path>` | Path to `personaxis.md` (default: `<cwd>/.personaxis/personaxis.md`). |
| `-i, --interval <seconds>` | Heartbeat interval for the drift check (default `30`, floored at `5`). |
| `--once` | Do a single reconcile pass then exit. |

## What the daemon does

Two loops run until you stop it:

1. **Debounced recompile on hand-edit.** It watches `personaxis.md` (`fs.watch`); when you edit the
   spec by hand it recompiles `PERSONA.md` (debounced ~800ms, ignoring duplicate fs events).
2. **Drift heartbeat.** Every `--interval` seconds it recompiles **only if** a governed self-edit
   marked `PERSONA.md` stale — a no-op otherwise.

## `--once` for serverless / CI

`--once` does a single reconcile pass (recompile if drift is pending, else report up-to-date) and
exits — the shape you want from a Vercel Cron / CI step where no long-lived process exists. On a
machine that *can* hold a process (VM, container), run the full daemon instead.

## See also

- [observe.md](./observe.md) — the per-turn tick (`--once` there runs one governed cycle).
- [hooks.md](./hooks.md) — wire per-turn learning into a host.
- [../architecture/deployment.md](../architecture/deployment.md) — daemon vs serverless shapes.
