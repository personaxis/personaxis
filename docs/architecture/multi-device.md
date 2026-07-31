# One persona, several machines

You work on a project from a desktop and a laptop. It is the same project and the same
persona, and everything it has learned should be there on both. This document is how that
is made to work, and why the obvious approaches do not.

## Why the previous shape could not do it

`state.json` is a document that gets overwritten, and the memory log is one hash chain
with one writer. Two machines editing either produce one of two failures:

- **Last write wins.** The second machine's copy replaces the first. Memory written on the
  desktop disappears when the laptop saves, with nothing to indicate it ever existed.
- **A broken chain.** Two writers appending to one chain produce links that do not follow
  from each other. The integrity check correctly reports tampering and cannot tell you
  which side is right, because from its point of view both are.

This is not a bug to patch. A single mutable file has a single writer, and here there are
several.

## The shape that works: one log per device

```
.personaxis/devices/<deviceId>/mutations.jsonl
```

Every device appends only to **its own** file. Nobody writes anybody else's, so file-level
conflict cannot occur, whatever carries the folder between machines. The state is then a
**fold** of every log.

This is the per-device-file pattern local-first systems converge on, and the same one
[presence](./presence.md) already uses in production for the same reason.

### Three properties this buys

**Deterministic.** Every machine folding the same entries computes the same state. There
is no authoritative copy to disagree with, and no "resync from the server" step.

**Envelope-preserving.** The clamp is applied at **every step** of the fold, so a merged
history obeys the declared bound exactly as a local one does.

> This is the subtle part. `clamp(a + b)` is not `clamp(a) + clamp(b)`. Summing deltas and
> clamping once at the end would let a value escape its envelope through a sequence that
> never individually did. Applying the clamp per entry, in an order every machine agrees
> on, is what makes the guarantee hold under merge. Order is not a detail here; it is the
> theorem.

**Reconstructible.** `state.json` becomes a cache. Delete it and it comes back:
`personaxis sync --rebuild`.

## Ordering without trusting clocks

Wall-clock timestamps cannot order events from machines that never talked to each other.
Clocks drift, get corrected, jump at DST, and are simply wrong on machines nobody
maintains. Two events a second apart can carry timestamps in the wrong order, and a merge
that believes them produces a history that never happened.

So each entry carries a **hybrid logical clock**: physical time as a readable hint, plus a
counter that keeps advancing when the clock stands still or moves backwards.

```
0001998a4c10-0003-b4f2c8a1d0e93f77
     wall      counter    device
```

The rule that makes it correct: **never emit a timestamp that sorts before something
already seen**. A machine that has just received a newer history from elsewhere keeps the
observed time and bumps its counter, rather than stamping the past. Ordering compares
wall, then counter, then device id, which makes it a *total* order: any two entries from
anywhere compare, and every machine sorts them identically.

A machine an hour behind still orders correctly. Its `wall` values look odd to a human
reading the log, which is why clock skew is reported rather than hidden.

## Integrity, per device

The hash chain is **per device**, because one global chain is incompatible with concurrent
writers by construction.

Practical consequence, beyond correctness: a break names the device and the position.
"Somebody edited the log on the laptop, at entry 12" is actionable; "the chain is broken"
condemns every machine at once and tells you nothing about where to look.

**A device with a broken chain is excluded from the merge**, not folded in with a warning.
Tamper-evidence is worth nothing if the tampered entries still shape the result.

## Transport is your choice

Nothing here builds sync infrastructure. Because each machine writes only its own file,
any of these works:

| Transport | Notes |
|---|---|
| git | commit and push the persona folder like the rest of the project |
| Syncthing | continuous, no third party |
| Dropbox / iCloud / OneDrive | fine: there is no shared file to conflict over |
| a USB stick | genuinely works |

We chose a **format that survives any transport** rather than a service you have to run.

## Seeing what merged

```bash
personaxis sync --status     # who contributed, chain health, what a merge produces
personaxis sync --rebuild    # recompute state.json from the logs
```

```
  Devices that have written to this persona
  this machine: D410 (b9ef2ae681e07781)

  ✓ b9ef2ae681e07781     2 entr(ies)  (this machine)
  ✓ 7c1f0a93bb2e4d58     1 entr(ies)

  What a merge produces
  3 mutation(s) applied · 1 clamped to their envelope
  contributed by: 7c1f0a93bb2e4d58, b9ef2ae681e07781
```

Never silent: a merge that quietly changes a persona is indistinguishable from a bug.

## Device identity

`~/.personaxis/device.json`, created once and then read. Persisted rather than derived
from hostname and username: a derived id changes when someone renames their computer, and
in a merged history that reads as a brand new device whose entries interleave with the old
ones under a different name.

## The write lease, and why it is optional

Everything above makes concurrent writing **safe**. It does not make it **wanted**. Someone
running an unattended loop overnight may prefer that a second machine cannot write at all
while it runs, so that the resulting history has one obvious author.

Hence an opt-in lease (`personaxis lease`, config `writeLease`). Three properties decide
whether a lock helps or hurts, and each drove a design choice:

**It must not outlive its holder.** A session lease is renewed on the same heartbeat as
presence, and a lease that stops beating for 90 seconds is reclaimable. A crash costs you a
minute and a half, not the persona.

**It must not lock you out of your own machine.** A hold taken from the command line exits
immediately, so a heartbeat rule would kill it seconds after you took it, and, being keyed
to a dead pid, would meanwhile block the very machine that took it. So there are two kinds:

| Hold | Identity | Expires |
|---|---|---|
| `session` | (device, pid): two REPLs on one machine are two writers | on heartbeat, 90s |
| `manual` | (device): the person took it for this machine | never; released by hand, or broken with `--force` |

Because a manual hold does not expire, `--force` exists: a machine switched off holding one
would otherwise strand the persona. Forcing records whose hold it broke.

**Two holders must be impossible.** Exclusive creation (`wx`) is the only atomic primitive a
plain filesystem offers, so the lease is taken by first creating a guard file, then writing
the lease inside that critical section. A guard left behind by a crash expires on the same
rule; a guard held *right now* makes the attempt fail rather than guess.

The lease is never a precondition. With none taken, every path behaves exactly as it does
without the feature; the lease only ever adds a restriction its holder asked for.

## What this does not cover

- **The persona spec itself** (`personaxis.md`) is not a log. It is a document people edit,
  so it merges the way documents do: git, with a conflict you resolve. Automatically
  merging two edits to a persona's identity is not something a machine should do quietly.
- **Project pairing** across machines relies on the git remote recorded with each project;
  see [`project-registry.md`](./project-registry.md). Without a shared identity, the same
  project on two machines is two unrelated entries.
