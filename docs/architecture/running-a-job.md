---
title: Running a job the workspace sent
version: 1.0.0
date: 2026-08-03
status: built, not yet exercised against a deployed gateway
---

# Running a job

The daemon has two halves. One refuses a tool call before it runs, and it works the same
whether the call came from a person typing in their terminal or from a job. The other starts
the agent in the first place, and until now it did not exist: `job.assign` was defined in the
protocol, the socket carried it, and no code matched on it. Everything around it was in
place, which is why nobody noticed.

Without this the workspace can watch a machine and never give it work, so the thing the
product promises, work that happens when nobody is there to start it, could not happen.

## The path

```
job.assign  →  JobRunner  →  HostSession  →  the vendor's binary
                   │              │
                   │              └─ stdout, one JSON object per line
                   │                        │
                   │                 HostStreamTranslator
                   │                        │
                   └──────── JobReporter ───┘  →  envelope, scope guard, socket
```

Four pieces, each with one job:

| Piece | Does | Does not |
|---|---|---|
| `JobRunner` | decides whether a job runs at all | know the vendor's stream |
| `HostSession` | owns the process and its ending | interpret what it says |
| `HostStreamTranslator` | turns one line into wire events | touch a process or a socket |
| `JobReporter` | envelope, scope guard, sequencing | know where events came from |

The translator is pure, so the decisions in it are tested against a transcript rather than
against a running agent.

## The call id belongs to the host

`tool.call.requested` carries a `call_id`, and a gate freezes one specific call by it. The
host already names each call, and **the hook that refuses a call before it runs is handed
that same name by the host**. So the wire uses the host's id verbatim.

Minting our own would give one call two names, and the gate a person approves in the browser
would be a different call from the one the hook is holding open on the laptop. That failure
is invisible until two calls are in flight, and then it approves the wrong one.

## What it refuses, and why refusing is an event

A job that cannot run says so on the wire: no host installed, no consented directory, one
already running, no prompt. The alternative is a job that sits in the workspace looking
queued forever, which is indistinguishable from a machine that went offline.

**The working directory comes from what the operator typed at `connect`, never from the
message.** `job.assign` carries a trigger context written elsewhere, and a workspace, or
anything that has compromised one, must not choose the directory a process starts in. Empty
scope means the job is refused, not that a home directory is used.

**The host is chosen on the machine**, from what is installed. Which agent runs on somebody's
laptop is theirs to decide, and a message that could name it would be a message that picks
which binary the daemon executes.

**One job at a time by default.** Several agents in the same working directory edit the same
files with no idea the others exist, and the result cannot be attributed to a run afterwards.

## Two guarantees about the ending

**The room always finds out the job is over.** If the agent exits without saying so, dies
from a signal, or never starts because the binary is missing, a session end is emitted
anyway, with the reason. A job that hangs open forever is worse than a failed one: nobody can
tell it apart from work still in progress.

**The agent does not outlive the daemon.** An orphaned agent still holds the consented
directories and still calls tools, with the one thing that refuses calls no longer running.
The child is killed on every exit path, and the listeners are removed when the run ends so a
daemon running many jobs does not accumulate one per job.

## What it will not publish

**Thinking blocks.** The model's private reasoning, in a room the whole team watches.
Publishing it is a privacy decision nobody made, so they are counted as withheld rather than
dropped.

**Verdicts.** `tool.call.allowed` and `tool.call.blocked` say what the policy decided, and
the policy is decided by the hook, before the call runs. A verdict inferred from a stream
that only shows what happened would report an allow for a call nobody checked.

**Anything it does not recognise.** An unknown message type is reported through `onSkip`, not
discarded. A stream that silently drops what it does not understand looks exactly like a
stream where the agent did nothing, and the day the vendor renames a message type is the day
a job room goes quiet with nothing in the logs.

## Per host

The launch spec lives with the adapter, next to everything else that differs by vendor, and
the binary name is written once: the machine probe derives its list from the adapters.

| Host | Starts with | Status |
|---|---|---|
| Claude Code | `claude -p --output-format stream-json --verbose` | driven |
| Codex | not driven | refused, with the reason |

Codex has no launch flags here on purpose. They have not been checked against the real
binary, and inventing them starts an agent in a mode nobody intended, in a real directory,
with real tools. The runner refuses and says so, which is worth more than a guess.

## What has not been verified

The stream shape is the one Claude Code documents for `--output-format stream-json`, and the
tests are written against transcripts in that shape. **Nobody here has watched this drive a
real agent end to end**, because that needs a deployed gateway to emit to. Until then this
carries the same caveat the Codex hook does: it is built to the documented contract, and the
gap between that and observed behaviour is real.
