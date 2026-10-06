# `personaxis init`

Scaffold a persona from the commented template.

```bash
personaxis init                  # asks what to create
personaxis init --agent          # an agent persona, from a template
personaxis init --user           # a user persona
personaxis init -f               # overwrite an existing file without asking
```

Without a flag it asks whether to create one of three things:

| Choice | Where it goes |
|---|---|
| Project baseline | `.personaxis/personaxis.md` and `.personaxis/policy.yaml` |
| Agent persona | `.personaxis/personas/<slug>/`, from the Marketing Guru template or a blank custom one |
| User persona (`kind: UserPersona`) | `.personaxis/user-personas/<slug>/` |

| Flag | Effect |
|---|---|
| `--agent` | create an agent persona, skipping the question |
| `--user` | create a user persona, skipping the question |
| `-f, --force` | overwrite an existing file without asking |

## What it generates

A complete persona that validates, at `spec_version 1.0.0`, with all ten layers, governance and
security, an inline `improvement_policy.mode`, and commented fields to fill in (`address`,
`voice_exemplars` and the rest of the layer-10 `persona` fields). Fill in the TODO fields,
run `personaxis validate`, then `personaxis compile`.

To build a persona from evidence instead of a template, use [`create`](./create.md).
