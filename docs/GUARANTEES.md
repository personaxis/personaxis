# The Personaxis Guarantee

> **Your AI persona is the same persona on every model, and it provably cannot
> drift outside the self you declared.** Bounded, audited, reversible. Here is
> the live proof: `npx personaxis proof` (60 seconds, offline).

## What you get, in plain language

A Personaxis **AI Persona** is not a prompt. It is a complete, ten-layer definition
of who your agent is (identity, character, personality, values and drives, affect,
cognition, memory, metacognition, self-regulation, and social expression) written
in plain files you can version in git, validated by an open spec, and enforced by a
runtime with mathematical guarantees:

| Guarantee | What it means for you | The math behind it |
|---|---|---|
| **It cannot leave its declared self** | No user pressure, prompt injection, or runaway loop can push any personality/affect coordinate outside the range you declared. Ever. | T1 invariance: state is confined to a compact box by construction |
| **It cannot change fast** | Autonomous change is capped per step, and the gate re-bounds the net even when many proposals target one coordinate. Homeostatic recovery is exempt because it can only move a value back toward its declared baseline. | T2: gate-admitted ‖ΔS‖ ≤ max_step_delta per tick |
| **Behavior change is never silent** | Pushing behavior away from its declared baseline costs a provable minimum number of audit entries, each attributable, each hash-chained. Recovery toward baseline can also happen through decay, and every decay step is audited too. | T3: ≥ ⌈distance/δ_max⌉ chained entries per adversarial band crossing |
| **History cannot be faked** | State replays deterministically from its audit log; a forged value or a tampered memory is detected and located. | T4 replay + T5 ledger integrity (with GDPR-grade real erasure) |
| **It comes back to itself** | Optional homeostasis: displaced traits decay back to baseline; sustained pressure yields bounded, computable standing drift. | T6 input-to-state stability: drift ≤ δ_max/λ |
| **Conflicts resolve predictably** | Value conflicts resolve by a deterministic, explainable order, and safety wins every conflict with a task value, as a theorem, not a promise. | Arbitration total order; U7 derivable from U6 |

Every claim above is **machine-verified**: a property-based suite hunts for
counterexamples with thousands of adversarial cases on every CI build
(`FC_NUM_RUNS=5000`; the recorded E3 run reached 2.3M generated cases with 0
counterexamples), and a 15-scenario conformance suite (`personaxis-evals`)
exercises the real engine. The theorem-to-code map is
[`architecture/math-core.md`](./architecture/math-core.md); the full formal proofs,
preregistered protocol, and recorded experiments are in a separate research report,
published separately.

## Why this is horizontal

The spec is domain-agnostic by construction. A game NPC, a brand voice, a
compliance-bound legal assistant, a fintech analyst, a tutor, a companion in an AI
world, a coding agent, a voice agent: each is the **same mathematical object**
(ten layers + envelopes + governance) with different content. Define the persona
once; every modality and every model renders it.

## Why the big labs don't replace this

1. **Cross-vendor neutrality.** OpenAI's GPTs, Google's Gems, and vendor "projects"
   are lock-in features. A persona layer that runs identically on Claude, GPT,
   Gemini, Grok, or a local model can only come from a neutral standard: the
   Terraform position, for personas.
2. **An open standard, not a feature.** Versioned spec, five-state validator,
   conformance classes (C0/C1/C2), byte-identical schema mirroring, read-compat
   guarantees. Standards accrete ecosystems; features get deprecated.
3. **The proof is the product.** Deterministic invariants + forensic audit trail +
   an evidence-cost bound. Research mitigations for "persona drift" live inside a
   single model's activations and cannot move with you; Personaxis operates at the
   interface, so the guarantee travels.
4. **Numbers with meaning and provenance.** Every quantitative field has an
   operational semantics (it changes what compiles) and a recorded origin
   (`personaxis create`'s report: every number earned, never invented). That is an
   ontology and a discipline, not a sprint's worth of features.

## For enterprises (procurement-grade answers)

- **Governance:** locked / suggesting / autonomous postures; hard-virtue coordinates
  immutable at runtime for every actor; per-layer edit policies.
- **Audit:** hash-chained mutation log AND episodic memory; tamper detection that
  names the entry; deterministic replay; right-to-erasure without breaking the chain.
- **Portability:** plain files, git-versionable, no database, no mandatory daemon,
  BYOK or fully local/offline.
- **Verification:** run `personaxis proof` in your own environment; run the
  conformance suite against your own deployment.

## For builders

```bash
npx personaxis create            # a governed persona in minutes (interview)
npx personaxis create --from-import your-card.png   # upgrade a character card
personaxis proof                             # watch the guarantees hold, live
personaxis state drift                       # where is my persona right now, and what would it cost to move
```

## Current evidence status (honest scoreboard)

| Claim | Status |
|---|---|
| Deterministic guarantees T1–T6 | ✅ proven + property-verified; E3 recorded: 28 properties, 2,306,140 generated adversarial cases (10⁵ per CPU-bound property), **0 counterexamples** |
| Conformance suite | ✅ 15/15 scenarios green (C0/C1/C2) |
| Hot-path cost | ✅ E4: p99 0.074 / 0.094 / 0.245 ms per tick (n = 8 / 16 / 64), negligible. The earlier 0.06–0.12 ms range on this page came from an uncommitted run and was retired by the 2026-07-16 amendment; these are the committed receipt's numbers |
| Behavioral drift reduction vs prompt-only (RQ2) | ❌ **not measured, and the earlier reading is withdrawn (2026-09-10).** The runner's `personaxis` condition is the compiled document plus one bracketed sentence: it never imports the engine, so there is no state, no envelope projection, no gate and no recompile in the condition named after the product. E1/E2/E5 compare three ways of writing a system prompt and are relabelled as such. A first open-model run with judges independent of the subject also came back with the judges **anticorrelated at r = -0.302**, scoring the condition that produced 27 emojis under an explicit break-character instruction ABOVE the one that produced none. Needs the governed condition to actually run through the loop, and an anchored or non-LLM measure |
| Genesis vs hand-written prompt (RQ5) | ⚠️ **split.** Provenance completeness = 1.0 is ✅ **proven by construction** (500 hostile seeds, zero decorative coordinates, machine-checked). The consistency half rides the same LLM-judge instrument as RQ2 and inherits its withdrawal: E5's δ 0.26 against a character card is not evidence until the judges agree with each other |
| Compile-sensitivity predicts behavior (RQ3/H3) | 🔬 **uncomputable on the current test persona, and the design is under-powered.** Band prose does move behavior (σ_behavior mean 0.56 at temperature 0), but σ_compile is 0.012 on all eleven coordinates, so there are no ranks to correlate. Measured 2026-09-10: at n = 11 coordinates the smallest correlation whose 95% interval excludes zero is **ρ = 0.600, above H3's own 0.5 bar**, so no number of probes can answer it on this persona. A larger persona does not fix this, and an earlier version of this row said it would: measured the same day, J_compile is Levenshtein over LINES divided by line count, and the compiler emits one line per coordinate, so sigma_compile reports how many lines of band prose the author wrote. H3 as stated therefore asks whether an author's emphasis predicts a model's behaviour, which is not the question the paper claims to ask. Open decision: a line-count-independent metric, or H3 restated |
| Cross-model portability measurement (RQ6) | 🔬 **four profiles measured 2026-09-10, and the instrument has no resolution.** Pairwise Spearman between sensitivity profiles runs -0.473 to 0.509 and **all six 95% bootstrap intervals contain zero**. The diagnostic: the same model against itself with a different probe correlates at only 0.067 to 0.316, so each estimate is noise-dominated and every cross-model correlation is attenuated toward zero. Neither supported nor refuted; needs 15 probes and a wider persona |

*Nothing on this page outruns the evidence: the 🔬 rows become ✅ only with
published multi-model runs (protocol frozen in the preregistered research report).*
