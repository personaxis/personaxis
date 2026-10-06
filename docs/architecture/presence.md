# Presence: who is using a persona right now

A persona is not held by one process. The same one may be open in a REPL on your desk,
driven by Claude Code on a laptop, and served over HTTP to a third agent, all at the same
moment. This document is how the CLI knows that, and why it is built the way it is.

## Why one marker file is not enough

A single marker file that says awake or nothing cannot describe three concurrent situations, and it
answers none of the questions you actually have:

- Is someone else editing this persona right now?
- Which agent is using it: my REPL, Claude Code, an MCP host?
- Is that instance alive, or did it crash three days ago?

## One file per instance

```
.personaxis/presence/<deviceId>-<pid>.json
```

Each process writes only its own file. Two instances never touch the same bytes, so no
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

- Writers refresh their heartbeat every 30 seconds, a third of the window below. The
  interval is derived from the window, never written down twice: two numbers that have
  to agree and live apart is how a writer ends up beating slower than readers expire, which
  drops a running instance off the fleet.
- Readers ignore anything older than 90 seconds, and delete it as they pass.
- Unreadable files are discarded the same way. A half-written or corrupt entry is not an
  instance.
- A clean exit withdraws the file immediately, but nothing depends on that happening.

The window is generous on purpose: a persona sitting at a prompt while somebody thinks is
idle, not gone, and dropping it from the list because nobody typed for a minute would be
worse than showing it slightly too long.

## Who announces, and who deliberately does not

The rule is one line: announce if you hold the persona long enough for someone else to collide with
you. Without it, a `serve` running for an hour, a `watch` daemon recompiling it and an MCP host driving
it would all read as idle, and a presence view that says nobody is here when somebody is has failed at
its one job.

| Surface | `host` | What it reports doing |
|---|---|---|
| the REPL | `repl` | `idle`, `answering` |
| `personaxis -p` | `headless` | `answering` |
| `serve` | `serve` | `serving http on <addr>:<port>` |
| `watch` | `compile` | `watching for spec edits` |
| `compile` | `compile` | `compiling PERSONA.md` |
| `observe`, and host hooks | `loop` | `running a governed tick` |
| `orchestrate --run` | `task` | `assigned task: …` |
| the MCP server | `mcp` | `driven by an MCP host` |

The `host` says through what the persona is being used; `activity` says what it is doing.
Keeping those apart is why `watch` and a one-shot `compile` share a host: both hold it to
produce the compiled document, and the activity tells them apart. A host per command would
grow a vocabulary nobody could read at a glance.

Read-only and instant commands (`validate`, `lint`, `ps`, `dash`) announce nothing. A
marker that appears and vanishes inside a few milliseconds is noise on disk that no reader
can see in time. `dash` is the pointed case: it watches a persona rather than using one.

One process is one holder. Presence is keyed by device and pid, so a nested operation
(`watch` calling `compile`) does not announce twice. It takes the same holder's line, and
gives it back on release, so the activity returns to `watching for spec edits` on its own.
Announcing twice was never an option the file layout could represent.

The MCP server is driven by use, not by a timer. It holds no persona of its own, it is
handed one per call, and it cannot know when the host walked away. So each call refreshes
(throttled to one write per heartbeat) and silence lets the entry expire, which says the
true thing: nobody is driving this persona right now. A timer would have kept claiming
otherwise while the host sat idle.

## Where it shows

The fleet (`personaxis menu` → Fleet) lists instances instead of a flag:

```
● main        claude-code+codex     2 instance(s) · this machine (repl) · MacBook (claude-code)
○ @helper     not compiled          idle
```

Two different questions, side by side, that used to be confused with each other:

- Reachable from asks whether a host agent could read this persona, by checking that
  its compiled document exists where that host looks. It is about the filesystem.
- Who is using it asks who is holding it right now. It is about live processes.

A persona can be reachable from four hosts and used by none, or used heavily and compiled
nowhere.

## Presence is observability, never a precondition

Every write is best-effort. A persona must keep working on a read-only filesystem, inside
a container, or anywhere the presence directory cannot be created. Nothing waits on it and
nothing fails because of it.

## Limits

Presence reports; it does not prevent. For people who prefer to serialise access there is the optional
write lease (see [multi-device](./multi-device.md)). Sessions are conversations on disk, while presence
is the processes attached right now. Each machine's instances appear in that machine's copy of the
persona folder, and they converge wherever the folder is shared.
