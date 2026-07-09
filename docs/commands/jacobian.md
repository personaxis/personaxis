# `personaxis jacobian` — which numbers actually matter

J_compile: the deterministic compile stage is a **step function** of each
coordinate's band, so its sensitivity is exact — no LLM, offline:

```bash
personaxis jacobian [-f path] [--json]
```

For every envelope coordinate, the persona compiles at each reachable band's
representative value; **σ** is the mean normalized line-edit distance between
adjacent bands' artifacts. `σ = 0` marks a **decorative number**: a mutable
coordinate whose value provably cannot change the compiled artifact (exit code 2
when any exist; also surfaced as the `decorative-number` lint warning). Fix by
declaring per-band `expression {low, moderate, high}` prose (SPEC §L3).

Bands the envelope cannot reach are skipped (an envelope narrower than a band
simply can't get there — that's the guarantee working, not an error).

The probe-based behavioral variant (J_behavior, MATH_CORE Def. 11) lives in the
experiment harness (`packages/evals/experiments/`, RQ3).
