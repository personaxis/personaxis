# Presence: who is using a persona right now

A persona is not held by one process. The same one may be open in a REPL on your desk,
driven by Claude Code on a laptop, and served over HTTP to a third agent, all at the same
moment. This document is how the CLI knows that, and why it is built the way it is.

## What it replaced, and why that was not enough

The old answer was a single marker file that said **awake** or nothing. One boolean cannot
describe three concurrent situations, and it answers none of the questions you actually
have:

- Is someone else editing this persona right now?
- Which agent is using it: my REPL, Claude Code, an MCP host?
- Is that instance alive, or did it crash three days ago?

## One file per instance

```
.personaxis/presence/<deviceId>-<pid>.json
```

Each process writes **only its own file**. Two instances never touch the same bytes, so no
locking is needed and no write can clobber another. That property is not a convenience: it
is the reason this shape was chosen, and it is the same reason multi-device sync uses it. A
single mutable file has a single writer; here there are many.

Each entry carries what you would want to know before touching something someone else is
using:

| Field | Why it is there |
|---|---|
| `deviceId`, `machine` | which computer, by hash and by the name a human recognises |
| `user`, `pid` | which account, which process |
| `host` | the surface driving it: `repl`, `claude-code`, `codex`, `mcp`, `serve`, … |
| `project`, `sessionId` | where it is working, and in which conversation |
| `activity` | what it is doing, in plain words |
| `since` | when it attached, preserved across heartbeats so "since" means since |
| `ts` | the heartbeat itself |

## Liveness is the heartbeat, never the file

A crashed process cannot clean up after itself. If the existence of a file counted as
proof of life, every crash would leave a permanent phantom, and phantoms accumulate: a
registry in this project once carried 26 dead projects because nothing was responsible for
removing them.

So:

- Writers refresh their heartbeat every 20 seconds.
- Readers ignore anything older than 90 seconds, and **delete it as they pass**.
- Unreadable files are discarded the same way. A half-written or corrupt entry is not an
  instance.
- A clean exit withdraws the file immediately, but nothing depends on that happening.

The window is generous on purpose: a persona sitting at a prompt while somebody thinks is
idle, not gone, and dropping it from the list because nobody typed for a minute would be
worse than showing it slightly too long.

## Where it shows

The fleet (`personaxis menu` → Fleet) lists instances instead of a flag:

```
● main        claude-code+codex     2 instance(s) · this machine (repl) · MacBook (claude-code)
○ @helper     not compiled          idle
```

Two different questions, side by side, that used to be confused with each other:

- **reachable from** asks whether a host agent *could* read this persona, by checking that
  its compiled document exists where that host looks. It is about the filesystem.
- **who is using it** asks who *is* holding it right now. It is about live processes.

A persona can be reachable from four hosts and used by none, or used heavily and compiled
nowhere.

## Presence is observability, never a precondition

Every write is best-effort. A persona must keep working on a read-only filesystem, inside
a container, or anywhere the presence directory cannot be created. Nothing waits on it and
nothing fails because of it.

## What it is not

- **Not a lock.** It reports; it does not prevent. An optional write lease is a separate,
  future mechanism for people who prefer to serialise access.
- **Not a session.** Sessions are conversations on disk; presence is which processes are
  attached right now.
- **Not synced between machines by itself.** Each machine's instances appear in that
  machine's copy of the persona folder. They converge wherever the folder is shared, which
  is the subject of the multi-device design.
