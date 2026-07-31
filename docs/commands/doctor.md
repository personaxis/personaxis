# `personaxis doctor`, is anything wrong?

One health check, run from the TUI (`/doctor`) or from a script. Same implementation: two
health reports that disagreed would be worse than one.

```bash
personaxis doctor                          # offline: touches no network
personaxis doctor --net                    # also ping the configured provider
personaxis doctor --json                   # machine-readable; exits 1 on any failure
```

Checks the spec validates, the lint findings, the memory chain's integrity, whether a model
is configured, and whether any work is pending (self-edit proposals, a stale compiled
document). Every finding comes with what to do about it: a warning without a remedy is
half an answer.

**The remedy is part of the finding, not a nicety.** `fix` is a REQUIRED field on every
validator issue and every lint finding, so the compiler, not a reviewer, is what stops a new
rule from shipping a bare verdict. What that changes in practice:

```
✗ spec FAIL_SCHEMA: 18 error(s)
    · character: must have required property 'character'
    fix: Add the missing field 'character' at the document root. `personaxis template`
         prints a scaffold with every MUST field in place.
```

**In the TUI it is a miniapp.** `/doctor` opens a view where `p` switches persona, so a
sub-persona's health is one key away instead of requiring `/doctor @slug` typed from memory.
`/doctor net` and `/doctor @slug` keep the text output (the network probe never runs from a
view that redraws on a timer).

**Offline by default.** The provider ping runs only with `--net`, so a health check never
touches the network, or a key, without being told to.

Exit code is `1` when anything failed, `0` otherwise, so it drops straight into CI.

| Flag | Effect |
|---|---|
| `-p, --persona <path>` | which persona to check (default: the one in scope) |
| `--net` | additionally ping the provider endpoint |
| `--json` | emit `{ ok, failures, warnings, lines }` |
