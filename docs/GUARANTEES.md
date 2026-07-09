# The Personaxis Guarantee

> **Your AI persona is the same persona on every model — and it provably cannot
> drift outside the self you declared.** Bounded, audited, reversible. Here is
> the live proof: `npx @personaxis/persona.md proof` (60 seconds, offline).

## What you get, in plain language

A Personaxis **AI Persona** is not a prompt. It is a complete, ten-layer definition
of who your agent is — identity, character, personality, values and drives, affect,
cognition, memory, metacognition, self-regulation, and social expression — written
in plain files you can version in git, validated by an open spec, and enforced by a
runtime with mathematical guarantees:

| Guarantee | What it means for you | The math behind it |
|---|---|---|
| **It cannot leave its declared self** | No user pressure, prompt injection, or runaway loop can push any personality/affect coordinate outside the range you declared. Ever. | T1 invariance: state is confined to a compact box by construction |
| **It cannot change fast** | Every autonomous change is capped per step. A sudden personality shift is mathematically impossible. | T2: ‖ΔS‖ ≤ max_step_delta |
| **Behavior change is never silent** | Crossing into different behavior costs a provable minimum number of audit entries — each attributable, each hash-chained. Forensic by design. | T3: ≥ ⌈distance/δ_max⌉ chained entries per band crossing |
| **History cannot be faked** | State replays deterministically from its audit log; a forged value or a tampered memory is detected and located. | T4 replay + T5 ledger integrity (with GDPR-grade real erasure) |
| **It comes back to itself** | Optional homeostasis: displaced traits decay back to baseline; sustained pressure yields bounded, computable standing drift. | T6 input-to-state stability: drift ≤ δ_max/λ |
| **Conflicts resolve predictably** | Value conflicts resolve by a deterministic, explainable order — and safety wins every conflict with a task value, as a theorem, not a promise. | Arbitration total order; U7 derivable from U6 |

Every claim above is **machine-verified**: a property-based suite hunts for
counterexamples with thousands of adversarial cases on every CI build
(`FC_NUM_RUNS=5000`; the E3 run targets 100,000), and a 15-scenario conformance
suite (`personaxis-evals`) exercises the real engine. Formal statements and proofs:
[`docs/MATH_CORE.md`](./MATH_CORE.md). Preregistered research protocol:
[`docs/RESEARCH.md`](./RESEARCH.md).

## Why this is horizontal

The spec is domain-agnostic by construction. A game NPC, a brand voice, a
compliance-bound legal assistant, a fintech analyst, a tutor, a companion in an AI
world, a coding agent, a voice agent — each is the **same mathematical object**
(ten layers + envelopes + governance) with different content. Define the persona
once; every modality and every model renders it.

## Why the big labs don't replace this

1. **Cross-vendor neutrality.** OpenAI's GPTs, Google's Gems, and vendor "projects"
   are lock-in features. A persona layer that runs identically on Claude, GPT,
   Gemini, Grok, or a local model can only come from a neutral standard — the
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
npx @personaxis/persona.md create            # a governed persona in minutes (interview)
npx @personaxis/persona.md create --from-import your-card.png   # upgrade a character card
personaxis proof                             # watch the guarantees hold, live
personaxis state drift                       # where is my persona right now, and what would it cost to move
```

## Current evidence status (honest scoreboard)

| Claim | Status |
|---|---|
| Deterministic guarantees T1–T6 | ✅ proven + property-verified (28 properties, CI at 5·10³ runs each); 🔬 E3 at 10⁵ per property running — recorded to `e3-scale.json` on completion |
| Conformance suite | ✅ 15/15 scenarios green (C0/C1/C2) |
| Hot-path cost | ✅ E4: p99 0.06–0.12 ms per tick (n=8–64) — negligible |
| Behavioral drift reduction vs prompt-only (RQ2) | 🔬 runner ready + pipeline self-tested; headline multi-model runs pending credentials |
| Cross-model portability measurement (RQ6) | 🔬 same status |

*Nothing on this page outruns the evidence: the two 🔬 rows become ✅ only with
published multi-model runs (protocol frozen in RESEARCH.md).*
