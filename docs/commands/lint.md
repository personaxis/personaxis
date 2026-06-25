# `personaxis lint`

Semantic, tier-aware findings against the layer/field contract — beyond schema validity. Reports
`error` (exit 1), `warning`, and `info`.

## Usage
```bash
personaxis lint <file>
```

## What it checks (selection)
- Required top-level fields + supported `spec_version` (0.3 … 0.10).
- Metadata completeness; layer coverage summary.
- **v0.10 persona-prompting** (honest, tier-aware): if `persona_prompting.address` is set,
  recommend a non-empty `you_are`; suggest 2-4 `voice_exemplars`; remind that
  `break_character_guardrails` never override safety; hint when the block is absent (the
  compiled doc will be derived from the quantitative layers).

## Example
```bash
personaxis lint .personaxis/personas/cmo/personaxis.md
```
