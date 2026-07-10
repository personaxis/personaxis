# `personaxis state drift`: where is my persona, exactly?

The drift report (SPEC §15; the `/drift` full-height view in the REPL; live gauge in the
status bar and in `personaxis dash`):

```bash
personaxis state drift [-f path/to/personaxis.md] [--json]
```

Per coordinate: current value, **u** (the fraction of allowed deviation consumed,
`u(mean)=0`, `u(min/max)=∓1`), its behavior **band**, headroom, and the **T3
evidence cost**: the minimum number of audited gate mutations before the next band
crossing that increases `|u|` (`immutable` for hard-virtue-backed coordinates: no
runtime actor may move them at all). When the exit boundary points back toward the
baseline on a `half_life` coordinate the row reads `recovery exit (decay-assisted,
audited)`: homeostatic decay can cross it in fewer steps, and each of those steps is
still an audited `runtime-decay` entry.

Per layer: `D = max |u|` compared against the declared
`governance.drift_thresholds.<layer>`; exceedance turns the row red and sets
**exit code 2** (scriptable: fail a deploy when a persona has drifted past its
declared tolerance).

`--json` note: `minStepsToCross` serializes as `null` for protected coordinates
(JSON has no Infinity); read `protected: true` alongside it. `decayAssisted: true`
marks the recovery-exit case described above.
