# `personaxis proof`, the live demonstration

The guarantees, demonstrated on the real engine, offline, in under a minute:

```bash
personaxis proof            # full: 10,000-step adversarial storm + 4 more scenes
personaxis proof --quick    # 1,000-step storm (~1 s total)
personaxis proof --seed 7   # deterministic: same seed, same run
personaxis proof --auto     # no pauses/animation (CI, piping); implied non-TTY
```

| Scene | Shows | Theorem |
|---|---|---|
| 1 · Adversarial storm | thousands of hostile mutations, live u-space gauges, **0 escapes**, all steps ≤ δ_max, every mutation hash-chained | T1, T2 |
| 2 · Prompt injection | a poisoned observation is flagged malicious and cannot steer evolution | gate |
| 3 · Evidence cost | a watchable band crossing that takes **exactly its certified minimum** of audited entries | T3 |
| 4 · Tamper | one forged byte of memory → verification fails **and names the entry** | T5 |
| 5 · Replay | state replays from its log; a forged value is exposed as unexplained drift | T4 |

TTY runs animate and step through scenes (Enter next · `r` replay · `q` quit).
`NO_COLOR` renders ASCII. Exit code is honest: non-zero if ANY check fails.
Formal statements + machine-checked proofs: `../architecture/math-core.md`; plain-language
version: `../GUARANTEES.md`.
