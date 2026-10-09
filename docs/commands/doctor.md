# `personaxis doctor`, check a persona's health

One health check, from the TUI (`/doctor`) or from a script. Both run the same code.

```bash
personaxis doctor                          # offline: touches no network
personaxis doctor --net                    # also ping the configured provider
personaxis doctor --json                   # machine-readable; exits 1 on any failure
```

Checks the spec validates, the lint findings, the memory chain's integrity, whether a model
is configured, and whether any work is pending (self-edit proposals, a stale compiled
document). Every finding carries a `fix` line saying what to change. The compiler requires
the field, so a new rule cannot ship without one:

```
✗ spec FAIL_SCHEMA: 18 error(s)
    · character: must have required property 'character'
    fix: Add the missing field 'character' at the document root.
```

In the TUI, `/doctor` opens a view where `p` switches persona, so a sub-persona's health is
one key away. `/doctor net` and `/doctor @slug` keep the text output (the network probe never
runs from a view that redraws on a timer).

Exit code is `1` when anything failed, `0` otherwise, so it drops straight into CI.

| Flag | Effect |
|---|---|
| `-p, --persona <path>` | which persona to check (default: the one in scope) |
| `--net` | additionally ping the provider endpoint |
| `--json` | emit `{ ok, failures, warnings, lines }` |
