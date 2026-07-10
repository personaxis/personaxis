# Creating personas: which door, and what to do after

Reference for flags/gates: [`docs/commands/create.md`](../commands/create.md) ·
design: [`docs/architecture/genesis.md`](../architecture/genesis.md). This guide is
the workflow: pick the right entry, review what Genesis earned vs assumed, iterate.

## Pick your door

| You have… | Use | What Genesis does with it |
|---|---|---|
| Nothing but a picture in your head | `personaxis create` (interview) | Likert items → trait means; a confidence item → envelope widths; value ranking → weights; dilemmas → hard limits & strategy. Fully offline, deterministic. |
| A paragraph ("terse ex-military smuggler who…") | `--from-prompt "<brief>"` | LLM extraction where **every number must quote its evidence**; unevidenced dimensions are omitted, never invented. |
| A repo / brand docs | `--from-project [dir]` | Reads README/CLAUDE.md/AGENTS.md/docs → proposes the project's own persona (role, scope, voice). |
| A SillyTavern-style card or a system prompt | `--from-import <file>` | Cards V2/V3 (`.json` and `.png` tEXt) map deterministically; prose fields go through evidence-quoted extraction. |
| Great example conversations | `--from-transcript <file>` | Induces the persona that explains the exemplars (voice, values, refusals). |

Doors **compose**: run the interview, then add `--from-import old-card.png`; later
evidence wins per field and every override stays visible in the report.

## Worked example (prompt → governed persona in 2 minutes)

```bash
personaxis create bartender --from-prompt "Kaya runs the dockside bar in a cyberpunk
port. Never reveals a patron's secrets; terse with strangers, warm with regulars;
refuses to discuss the syndicate. Curious about off-world news."
personaxis validate .personaxis/personas/bartender/personaxis.md   # PASS (guaranteed)
```

Then read `creation-report.md` next to it. Two sections matter:

1. **Provenance**: which sentence produced each mean/weight/limit ("never reveals a
   patron's secrets" gives a hard limit + `discretion` virtue), and whether each
   coordinate's behavior prose was `earned` from a quote, `synthesized` from the
   construct table, or a labeled `default`. If a number's evidence looks weak, fix the
   *brief*, not the YAML.
2. **Defaults**: every number Genesis had to assume, labeled. This is your review
   checklist: each default is either fine or worth an interview question.

## The numbers are already load-bearing (verify, then tune)

Genesis fills per-band `expression` prose for every trait and affect coordinate, so a
fresh persona has **no decorative numbers**. Confirm it:

```bash
personaxis jacobian -f .personaxis/personas/bartender/personaxis.md   # 0 decorative
```

A coordinate is **decorative** (σ = 0) when its value provably cannot change the
compiled document. Genesis will not ship one; the create gate repairs it by synthesis
before writing. What you tune is the *wording*, not the presence, of the prose. Genesis
synthesized something plausible; sharpen the traits you care about by hand:

```yaml
warmth:
  mean: 0.35
  range: [0.15, 0.75]
  expression:
    low: "Single-sentence answers. No names, no questions back."
    moderate: "Efficient but remembers your usual."
    high: "Leans on the bar, asks about your run."
```

Crossing a band *rewrites the compiled persona* and costs a provable minimum of audit
entries (run `personaxis state drift` to see the price of every crossing).

## Iterate under governance, not by re-rolling

Don't regenerate the persona when something's off; that throws away provenance.
- Wording/voice → edit `PERSONA.md`, then `personaxis decompile` to fold it back.
- One value → `personaxis edit <dot-path> <value>` (re-validates, refuses
  universal-breaking edits).
- Behavior over time: run it in the REPL, watch the `/drift` view, and let homeostasis
  (`half_life`) pull moods back to baseline.

## Quality bar before you ship one

```bash
personaxis validate <spec>     # PASS, not PASS_WITH_WARNINGS, for production
personaxis lint <spec>         # tier-aware findings; fix MUST/SHOULD
personaxis jacobian <spec>     # no decorative numbers on traits you care about
personaxis state drift         # thresholds declared and honest (CI gate: exit 2)
```

Vertical starting points (NPC, brand voice, legal, tutor, …): [`recipes.md`](./recipes.md).
