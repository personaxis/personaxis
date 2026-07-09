# `personaxis init`

Scaffold a new persona — generates a valid `personaxis.md` (spec 0.10) + `policy.yaml`. Interactive.

## Usage
```bash
personaxis init [slug]
```
- no slug → the project ROOT persona under `.personaxis/`.
- `<slug>` → a sub-persona under `.personaxis/personas/<slug>/`.

## What it generates
A complete, validating persona at `spec_version 1.0.0` with all 10 layers + governance +
security, `identity.short_name`, an inline `improvement_policy.mode`, and commented
layer-10 `persona` prompting fields (`address`, `voice_exemplars`, … — uncomment + fill to
enrich the compiled PERSONA.md). Review the output, then `personaxis compile`.

## Example
```bash
personaxis init                 # root persona
personaxis init cmo             # a sub-persona
```
