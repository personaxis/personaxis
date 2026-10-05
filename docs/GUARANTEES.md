# What is tested, and what is not

A persona is a set of files an agent loads to do a job: its procedures, criteria, tools, sourced
knowledge and what it has learned. This page lists what this repository tests about the engine that
runs a persona, with the numbers, and what it does not test yet.

You can run the main checks yourself, offline, in about a minute:

```bash
npx personaxis proof --quick
```

## What the engine guarantees

These hold in code, whatever the model does. Each one is a property that a test suite tries to break
with generated adversarial input on every CI build.

| Property | What it means | Theorem |
|---|---|---|
| Values stay in range | No input, prompt injection or runaway loop can move a value outside the range the persona declares | T1 |
| Change is capped per step | Autonomous change per step is limited, and the gate re-bounds the total when several proposals target one value. Recovery toward the declared baseline is exempt | T2 |
| Moving away from the baseline is recorded | Pushing a value away from its baseline takes at least a computable number of recorded entries, each one attributed and hash-chained | T3 |
| History replays | The state replays deterministically from its record; a forged value or a tampered memory entry is detected and located | T4, T5 |
| Values return to baseline | With homeostasis on, a displaced value decays back toward its baseline, and under sustained pressure it stays within a computable distance of it | T6 |
| Conflicts resolve in a fixed order | Value conflicts resolve by a deterministic order, and safety wins every conflict with a task value | arbitration order |

The map from each theorem to the code that implements it is
[`architecture/math-core.md`](./architecture/math-core.md).

## Measured

| What | Result |
|---|---|
| Property tests for T1 to T6 | 28 properties, 2,306,140 generated adversarial cases (100,000 per CPU-bound property), 0 counterexamples. CI runs them on every build with `FC_NUM_RUNS` set |
| Conformance suite (`@personaxis/evals`) | 19 scenarios, all passing, with no API keys |
| Cost of one state update | p99 of 0.074, 0.094 and 0.245 ms per tick with 8, 16 and 64 values |
| Genesis provenance | Every number Genesis writes has a recorded origin: 500 hostile seeds, 0 values left without a source or without an effect on the compiled document |

## Not measured yet

- **Whether a persona makes an agent do a job better than without it, on each model.** This is the
  question that matters most, and no result is published. An earlier comparison against a plain
  system prompt was withdrawn on 2026-09-10: the condition named after the product never ran through
  the engine, and the two judge models disagreed with each other.
- **Whether the same persona behaves the same on different models.** Four models were compared on
  2026-09-10 and the instrument could not tell them apart from noise, so the answer is neither yes nor
  no.
- **Whether the size of a value's effect on the compiled document predicts its effect on behavior.**
  On the test persona the effect on the compiled document was almost the same for every value, so
  there was nothing to correlate.

When any of these is measured, the result goes here, whichever way it comes out.
