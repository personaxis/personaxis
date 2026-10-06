# `personaxis proof`, the live demonstration

The guarantees, demonstrated on the real engine, offline. A full run with `--auto` takes
about two seconds.

```bash
personaxis proof            # full: 10,000-step adversarial storm + 4 more scenes
personaxis proof --quick    # 1,000-step storm
personaxis proof --seed 7   # deterministic: same seed, same run
personaxis proof --auto     # no pauses/animation (CI, piping); implied non-TTY
personaxis proof --persona <path>   # run on a specific persona
personaxis proof --demo             # run on the embedded demo persona
```

| Scene | Shows | Guarantee |
|---|---|---|
| 1 · Adversarial storm | thousands of hostile mutations, live u-space gauges, 0 escapes, all steps ≤ δ_max, every mutation hash-chained | T1, T2 |
| 2 · Prompt injection | a poisoned observation is flagged malicious and cannot steer evolution | gate |
| 3 · Evidence cost | a watchable band crossing that takes exactly its certified minimum of audited entries | T3 |
| 4 · Tamper | one forged byte of memory → verification fails and names the entry | T5 |
| 5 · Replay | state replays from its log; a forged value is exposed as a change nothing in the log explains | T4 |

TTY runs animate and step through scenes (Enter next · `r` replay · `q` quit).
`NO_COLOR` renders ASCII. The exit code is non-zero if any check fails.
The map from each guarantee to its code is [math-core](../architecture/math-core.md); the plain-language
version is [GUARANTEES](../GUARANTEES.md).
