# `personaxis lint`

Semantic, tier-aware findings against the layer/field contract, beyond schema validity. Reports
`error` (exit 1), `warning`, and `info`.

## Usage
```bash
personaxis lint <file>
```

## What it checks (selection)
- Required top-level fields + supported `spec_version` (0.3 … 0.10, 1.0). The linter is
  version-aware: at v1.0 it expects `apiVersion personaxis.com/v1`, the layer-9 name
  `self_regulation`, and no `metadata.display_name`; legacy personas are checked at their
  legacy paths.
- Metadata completeness; layer coverage summary.
- **Persona prompting** (honest, tier-aware): if the layer-10 `persona.address` is set,
  recommend a non-empty `you_are`; suggest 2-4 `voice_exemplars`; remind that hard limits
  never override safety; hint when the material is absent (the compiled doc will be derived
  from the quantitative layers).

## Every finding carries its remedy

`fix` is a **required** field on `Finding`, so the compiler is what stops a new rule from
shipping a bare warning. It prints under each finding:

```
warning  personality.traits.humor   'humor' declares an envelope but no per-band expression …
         fix: Add expression: {low, moderate, high} under personality.traits.humor, each line
              saying how the persona actually behaves in that band. Right now the number is
              decorative: `personaxis jacobian` shows it moves nothing.
```

Where the honest remedy is "nothing to change in the file", it says so and explains why (the
`memory-policy-unenforced` findings report a gap in THIS runtime, not a defect in your
persona).

## Example
```bash
personaxis lint .personaxis/personas/cmo/personaxis.md
```
