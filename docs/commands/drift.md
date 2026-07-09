# `personaxis state drift` — where is my persona, exactly?

The drift report (SPEC §15; `/drift` in the REPL; live gauge in `personaxis dash`):

```bash
personaxis state drift [-f path/to/personaxis.md] [--json]
```

Per coordinate: current value, **u** (the fraction of allowed deviation consumed,
`u(mean)=0`, `u(min/max)=∓1`), its behavior **band**, headroom, and the **T3
evidence cost** — the minimum number of audited mutation-log entries any non-human
trajectory needs before the next band crossing (`immutable` for hard-virtue-backed
coordinates: no runtime actor may move them at all).

Per layer: `D = max |u|` compared against the declared
`governance.drift_thresholds.<layer>`; exceedance turns the row red and sets
**exit code 2** (scriptable: fail a deploy when a persona has drifted past its
declared tolerance).

`--json` note: `minStepsToCross` serializes as `null` for protected coordinates
(JSON has no Infinity) — read `protected: true` alongside it.
