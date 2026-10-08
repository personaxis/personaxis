# Creating personas

How to pick the right way in, review what the model quoted versus what it inferred, and improve a persona
without throwing that record away. Every flag is in [`docs/commands/create.md`](../commands/create.md);
the design is in [`docs/architecture/genesis.md`](../architecture/genesis.md).

Configure a model first (`personaxis config`). A model writes every field, so without one `create`
refuses and says how to configure one.

## Pick the way in

| What you have | Use | What Genesis does with it |
|---|---|---|
| Nothing written yet | `personaxis create` (interview) | A model asks about the job, at most fifteen questions; the answers are the source it writes from |
| A description of the job | `--from-prompt "<brief>"` | The brief is the source; each field quotes the words it came from, or says what it was inferred from |
| A repository or a set of docs | `--from-project [dir]` | Reads the README, `CLAUDE.md`, `AGENTS.md` and docs as one source for the project's own persona |
| A SOUL.md or SoulSpec package, a character card, a system prompt | `--from-import <file>` | The whole file is one source, card fields labelled; the model reads and cites it |
| Good example conversations | `--from-transcript <file>` | The conversations are the source; the model infers the persona that explains them |

Add `--research` to any of them to search the web for the field and keep what it found in
`references/`, each source with its date (needs a web provider key). `--profile regulated | standard |
research` sets how wide the ranges start, who approves lasting changes and how fast values return to
baseline.

The ways in combine: `--from-project --from-prompt "more formal"` hands the model both sources, numbered,
and the report shows which one each field cites.

## Worked example

```bash
personaxis create auditor --research --from-prompt "A security reviewer for web APIs. Checks
authentication, authorization and input validation first; never approves a change that logs
secrets; cites the OWASP item behind every finding; asks for the threat model when it is missing."
personaxis validate .personaxis/personas/auditor/personaxis.md     # PASS
```

Then read `creation-report.md` next to it. Two sections matter:

1. **Inferred, not stated by a source.** Every field the model filled without a source saying it, with
   what it inferred it from. This is the review list: each inference is either right or worth a
   sentence in the brief.
2. **Each stage.** The model's reasoning per layer, how many repairs the checks asked for, and the words
   each field quotes ("never approves a change that logs secrets" becomes a hard limit). If the support
   for a value looks weak, change the brief, not the YAML.

A persona is more than its values. Look at `skills/` and `references/` too: the procedures it follows
and the sources it cites are what most change how it does the job.

## Tune the wording

The model writes behavior text for each band of each value, and Genesis refuses a value whose range
never crosses a band, so every value changes the compiled document (`personaxis jacobian` lists any that
do not). What you tune is the wording on the values you
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
