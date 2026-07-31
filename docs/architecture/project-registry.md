# The project registry: how personaxis knows what personas you have

A persona lives inside a project folder. To answer "show me every persona I have, and what
each one is doing", the CLI needs to know where those folders are. This document is how that
knowledge is acquired, why it is acquired that way, and what it deliberately does not do.

## The rule

> **The registry learns by USE, never by searching your disk.**

The moment a persona is created, opened, compiled, messaged or diagnosed, the CLI already
knows exactly where it is. That is when it gets recorded. Registration is a by-product of
using the tool: one small write, always correct, because it reflects something that actually
happened.

Concretely, `personaxis` registers the project in a `preAction` hook, so **every** command
does it, not just entering the REPL.

```
~/.personaxis/registry.json
  projects:
    C:\Users\me\GitHub\cli:
      slugs:   [helper]                      # sub-personas found in the project
      origin:  github.com/me/cli             # portable identity (see below)
      machine: b9ef2ae681e07781
      lastSeen: 2026-07-21T09:14:00.000Z
```

### Why not scan the filesystem

Because it is the wrong default, on three counts:

1. **It is slow and wasteful.** A real run over one source folder walked ~1700 directories to
   find four projects. Every one of those reads is work spent rediscovering something the
   tool was already told.
2. **It rediscovers what we already know.** If you opened a persona, we had its exact path in
   hand. Throwing that away and searching for it later is a worse version of the same answer.
3. **It reads folders nobody asked us to read.** Walking someone's disk is not a feature that
   becomes acceptable because it is convenient.

A scan does exist, but as **recovery**, not as the mechanism. See below.

## Portable project identity

A path cannot identify a project across machines. The same repository is
`C:\Users\me\GitHub\cli` on one and `/home/me/src/cli` on another; a path-keyed registry sees
two unrelated projects and nothing can pair them.

So a project's portable identity is its **git remote**, normalised so every clone yields the
same string:

| Remote as written | Stored as |
|---|---|
| `git@github.com:me/cli.git` | `github.com/me/cli` |
| `https://github.com/me/cli` | `github.com/me/cli` |
| `https://github.com/me/cli.git` | `github.com/me/cli` |

Read straight from `.git/config`, not by shelling out to `git`: this runs on every command,
git may not be installed, and a subprocess per invocation is a cost with no upside.

Projects that are not git repositories have no `origin` and are keyed by canonical path.
They work fully, but they are local to one machine and the CLI is explicit about that.

**This field is what makes multi-machine work possible at all**: without a shared identity,
your PC and your laptop hold two unrelated entries for the same project, and nothing can
reconcile them.

## Staying true over time

The registry self-heals on every read that displays it:

| Situation | What happens |
|---|---|
| The folder was deleted | The entry is dropped |
| The folder is still there but `.personaxis/` was deleted | The entry is dropped: no persona, no project |
| The path is under the OS temp directory | Never registered, and purged if present |

That last rule exists because a real registry once held 26 projects, 25 of them throwaway
temp directories from test runs, all long deleted. A directory under the system temp folder
is nobody's project.

## The scan, and when it is legitimate

```bash
personaxis overseer scan --root ~/Documents/GitHub    # ad hoc
personaxis overseer scan                              # over the folders you configured
```

It exists for exactly one situation: **projects that already existed before you started
using the CLI**, which by definition were never registered by use. Run it once, and from
then on registration by use keeps up.

Its constraints are deliberate:

- **Never automatic.** Nothing scans on startup, on a timer, or "helpfully".
- **Only where you say.** Either `--root`, or the `scanRoots` you put in your config.
- **Bounded.** Depth-limited, skipping `node_modules`, `.git`, build output and friends. On
  finding a project it stops descending: sub-personas live inside it and are discovered from
  the persona itself, not by walking further.

```jsonc
// ~/.personaxis/config.json
{ "scanRoots": ["~/Documents/GitHub", "~/work"] }
```

## Sub-personas are not discovered by scanning

Inside a project, sub-personas are read from the persona tree
(`.personaxis/personas/<slug>/personaxis.md`). The filesystem scan stops at the project
boundary. One mechanism per question: the disk answers "where are the projects", the persona
answers "what is inside me".

## What the registry is not

- **Not a source of truth about a persona.** It is an index of locations. Every persona's
  actual state, memory and audit trail lives in its own folder, and works whether or not the
  registry knows about it.
- **Not shared between machines by itself.** It records which machine saw what. Reconciling
  the same persona across machines is a separate mechanism built on `origin`.
- **Not required.** Delete `registry.json` and every persona still runs; you only lose the
  cross-project view until use fills it in again.
