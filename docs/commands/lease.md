# `personaxis lease`

Optional exclusive **write lease** on a persona: while it is held, only the holder writes.

```bash
personaxis lease status              # who holds it, if anyone
personaxis lease take --reason "..." # take it for this machine
personaxis lease release             # give it back
personaxis lease status --json       # for scripts and agents
```

## When you need it (and when you do not)

You usually do not. A persona used from several machines is already safe without a lease:
each writer owns its own append-only chain, and merged history is folded under a total order
with the envelope clamp applied at every step, so concurrent evolution still lands inside the
declared envelope. See [multi-device.md](../architecture/multi-device.md).

Take a lease when you would rather **serialise** than merge:

- a long unattended run (`personaxis loop`) that should be the only author of that stretch,
- a publish or migration you want no other machine writing across,
- a shared persona where you want one obvious owner at a time.

## Two kinds of hold, because they cannot expire the same way

| Hold | Taken by | Expires |
|---|---|---|
| `session` | a running REPL, when `writeLease` is on in config | when the process stops heartbeating (90s), so a crash never locks the persona forever |
| `manual` | `personaxis lease take` | never on its own: the command exits immediately, so a heartbeat rule would kill the hold seconds after you took it. Released by hand, or broken with `--force` |

A manual hold belongs to the **machine**, so every later command you run there still writes.
A session hold belongs to the **process**, because two sessions on one machine are two
writers, which is exactly what the lease is for.

## Turning on the session lease

```json
// .personaxis/config.json  (or the global one)
{ "writeLease": true }
```

With it on, a REPL that cannot take the lease says so and continues **read-only**, naming the
machine, user and reason that hold it. Off (the default), nothing changes.

## Breaking a hold

```bash
personaxis lease take --force
```

Needed because a manual hold does not expire: a machine switched off while holding it would
otherwise strand the persona. Forcing is recorded, and the output names the hold it broke.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | taken, renewed, reclaimed, released, or status printed |
| 1 | `take` refused: someone else holds it (the JSON carries `heldBy`) |
| 2 | unknown action |

## Related

- `personaxis ps` — who is awake in this project
- `personaxis sync` — what each device contributed after a merge
- [multi-device.md](../architecture/multi-device.md) — why the lease is optional
