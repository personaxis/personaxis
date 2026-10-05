# Creating personas

How to pick the right way in, review what Genesis found versus what it assumed, and improve a persona
without throwing that record away. Every flag is in [`docs/commands/create.md`](../commands/create.md);
the design is in [`docs/architecture/genesis.md`](../architecture/genesis.md).

Configure a model first (`personaxis config`). Without one, Genesis still writes a valid persona, but
most of it is labelled defaults.

## Pick the way in

| What you have | Use | What Genesis does with it |
|---|---|---|
| Nothing written yet | `personaxis create` (interview) | Twelve questions turn into values, ranges, weights and limits; `--deep` asks the full bank. Works offline |
| A description of the job | `--from-prompt "<brief>"` | A model extracts what the brief says; every value must quote the sentence it came from, and anything the brief does not say is left to a labelled default |
| A repository or a set of docs | `--from-project [dir]` | Reads the README, `CLAUDE.md`, `AGENTS.md` and docs, and proposes the project's own persona |
| A SOUL.md or SoulSpec package, a character card, a system prompt | `--from-import <file>` | Structured fields map directly; prose goes through the same quoted extraction |
| Good example conversations | `--from-transcript <file>` | Infers the persona that best explains them |

Add `--research` to any of them to search the web for the field and keep what it found in
`references/`, each source with its date (needs a web provider key). `--profile regulated | standard |
research` sets how wide the ranges start, who approves lasting changes and how fast values return to
baseline.

The ways in combine: run the interview, then `--from-import` an older prompt; later evidence wins per
field, and every override is visible in the report.

## Worked example

```bash
personaxis create auditor --research --from-prompt "A security reviewer for web APIs. Checks
authentication, authorization and input validation first; never approves a change that logs
secrets; cites the OWASP item behind every finding; asks for the threat model when it is missing."
personaxis validate .personaxis/personas/auditor/personaxis.md     # PASS
```

Then read `creation-report.md` next to it. Two sections matter:

1. **Provenance.** Which sentence produced each value, weight and limit ("never approves a change that
   logs secrets" becomes a hard limit), and whether each value's behavior text was earned from a
   quote, synthesized, or a labelled default. If the evidence for a value looks weak, change the
   brief, not the YAML.
2. **Defaults.** Every value Genesis had to assume. This is the review list: each default is either
   fine or worth a sentence in the brief.

A persona is more than its values. Look at `skills/` and `references/` too: the procedures it follows
and the sources it cites are what most change how it does the job.

## Tune the wording

Genesis writes behavior text for each band of each value, so every value changes the compiled
document (`personaxis jacobian` lists any that do not). What you tune is the wording on the values you
care about:

```yaml
conscientiousness:
  mean: 0.8
  range: [0.6, 0.95]
  expression:
    low: "Flags the critical findings and stops."
    moderate: "Covers every OWASP category the change touches."
    high: "Covers every category and writes a test for each finding."
```

## Improve it without starting over

Regenerating throws away the provenance. Instead:

- Wording or voice: edit `PERSONA.md`, then `personaxis decompile` to fold it back into the definition.
- One value: `personaxis edit <dot-path> <value>`, which re-validates and refuses edits that break a
  universal rule.
- Behavior over time: run it in the REPL and read `/audit`.

## Before you ship one

```bash
personaxis validate <spec>     # PASS, not PASS_WITH_WARNINGS
personaxis lint <spec>         # fix every finding marked MUST or SHOULD
```

Starting points for other kinds of work: [`recipes.md`](./recipes.md).
