# Creating personas

How a persona is made, what to give it, how to review what the model quoted versus what it inferred, and
how to improve a persona without throwing that record away. The commands are
[`init`](../commands/init.md) and [`create`](../commands/create.md); the design is in
[`docs/architecture/genesis.md`](../architecture/genesis.md).

Configure a model first (`personaxis config`). A model writes every field, so without one nothing is
created.

## One process, in one order

Open a terminal in the folder the persona will work in and run `personaxis init` (this folder's persona)
or `personaxis create <name>` (another one beside it). Whatever the case, it goes in this order:

1. **The folder**: the model reads its tree, the files that explain it and the personas already there.
2. **What you want it for**, optional: say it in the command (`personaxis init "..."`) or when asked.
   It wins over the folder when they disagree.
3. **What you point at**, optional: `--from-import` (a SOUL.md, a character card, a system prompt),
   `--from-transcript` (conversations of how it should work), `--research` (the field, read on the web).
4. **The interview**: the model asks only what all of that leaves open, about real work; skip any question
   and it infers the answer and says from what.
5. **The persona**, its coherence reading, and its `PERSONA.md`.

The more of the real work the sources hold (how a review is done, what was rejected and why, what must
never happen), the less the model has to infer. `--profile regulated | standard | research` sets the
stance on how wide values move, who approves lasting changes and how fast values return to baseline.

## Worked example

```bash
cd payments-api
personaxis create auditor --research "A security reviewer for this API. Checks authentication,
authorization and input validation first; never approves a change that logs secrets; cites the OWASP item
behind every finding; asks for the threat model when it is missing."
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
