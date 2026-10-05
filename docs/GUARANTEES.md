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

## The scoreboard

Every figure below is checked against `docs/evidence.json` by a test: a figure that disappears from
this page, or a withdrawn one that comes back, fails the build.

| Claim | Status |
|---|---|
| The engine's guarantees T1 to T6 | ✅ Proven and property-tested: 28 properties, 2,306,140 generated adversarial cases (100,000 per CPU-bound property), 0 counterexamples |
| Conformance suite (`@personaxis/evals`) | ✅ 19/19 scenarios pass, with no API keys |
| Cost of one state update | ✅ p99 of 0.074 / 0.094 / 0.245 ms per tick with 8, 16 and 64 values |
| Genesis against a hand-written prompt | ⚠️ Split. Provenance holds by construction: 500 hostile seeds, zero decorative values. Whether the result behaves more consistently depends on the same judges as the next row, so it is not evidence yet |
| Whether a persona makes an agent behave better than the same content as a plain prompt | ❌ Withdrawn, not measured. The condition named after the product never ran through the engine, and the two judge models disagreed with each other at r = -0.302, scoring the version that produced 27 emojis under an instruction to break character above the one that produced none |
| Whether a value's effect on the compiled document predicts its effect on behavior | 🔬 Uncomputable on the test persona: the effect on the document was 0.012 on all eleven coordinates, and with eleven coordinates the smallest correlation that could be told from zero is 0.600 |
| Whether the same persona behaves the same on different models | 🔬 No resolution. Four models compared: correlations from -0.473 to 0.509, and the same model against itself only 0.067 to 0.316, so every estimate is mostly noise |

The question that matters most for a persona you load into an agent, whether it makes the agent do a
job better on each model, is not measured yet. When it is, the result goes in this table, whichever
way it comes out.
