# Recipes: personas for specific jobs

Each recipe is a starting point for one job: the `create` command, the spec choices that matter for that
job, and what to check afterwards. A persona holds the procedures, criteria, tools, sourced knowledge and
learned memory for the job, so the choices below are mostly about those, not about personality.

The general pattern: `personaxis create <slug> --from-prompt "<brief>"` (or `--from-project`,
`--from-import`), read `creation-report.md` to see what was earned and what was assumed, refine with the
interview or `personaxis edit`, then `personaxis compile --platform <host>` to load it. Add per-band
`expression` prose to every trait you care about; `personaxis lint` flags numbers that are still decorative.

None of these recipes comes with a measured result. Whether a persona makes an agent do a job better on a
given model is the open question listed in [GUARANTEES](../GUARANTEES.md).

## 1. Code reviewer for Claude Code or Codex

```bash
personaxis create reviewer --from-import CLAUDE.md --research
personaxis compile reviewer --platform claude-code   # .claude/agents/reviewer.md
```

- What matters: the review procedure as skills (what to read first, what to run, how to report), the
  criteria as `values` and `prohibited_behaviors`, `verification` gates and `agent_budget` stop
  conditions, and `references/` from `--research` so the sources are on disk with their dates.
- Check: open `PERSONA.md` and read it as the agent would; run the reviewer on a diff you already know
  the answer to.

## 2. Contract review assistant

```bash
personaxis create counsel --from-prompt "In-house contract review assistant. \
Cites clause numbers, never gives definitive legal advice, escalates ambiguity, \
discloses uncertainty aggressively."
```

- What matters: `cognition.uncertainty_policy` tight (disclose at 0.2, abstain at 0.5), hard limits for
  the lines it must not cross, and the hash-chained record as the audit trail of what it did.
- Check: `personaxis audit --tab Integrity`, then `personaxis proof` to see tampering detected and
  located and history replayed.

## 3. Brand voice

```bash
personaxis create voice --from-project ./brand-assets
```

- What matters: `voice_exemplars` from real approved copy, `prohibited_behaviors` as the legal and brand
  no-list, `improvement_policy: locked` so the voice does not change on its own, and narrow envelopes.
- Check: compile it for two hosts and compare the output on the same brief.

## 4. Tutor

```bash
personaxis create tutor --from-prompt "Patient socratic math tutor for teens. \
Never gives the answer outright, celebrates partial progress, adapts pace."
```

- What matters: the teaching procedure as a skill, `patience` with a generous envelope and a
  `half_life` so it recovers after a frustrating session, band `expression` prose that turns the same
  trait into different scaffolding styles, and `memory.user_preferences` on for per-student adaptation.
- Check: erasure works through tombstones, and the chain still verifies afterwards.

## 5. Sales development agent

```bash
personaxis create sdr --from-prompt "SDR for a developer-tools company. Qualifies before pitching, \
never overpromises, stops after two unanswered messages."
```

- What matters: the qualification procedure as a skill, `honest_measurement` weighted above
  `close_the_deal` (`personaxis arbitrate honest_measurement close_the_deal` shows the order), and
  `agent_budget` to cap runaway outreach loops.

## 6. A character from an existing card

```bash
personaxis create --from-import card.png
```

- What matters: the import turns a prose card into a governed persona, and the creation report shows what
  the card justified and which numbers are defaults.
