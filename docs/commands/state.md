# `personaxis state`

Inspect and mutate the runtime `state.json` (mood/affect dials) — **envelope-clamped** to the
ranges declared in the spec. Distinct from self-evolution (which edits the spec under
governance); state is operational and changes regardless of `improvement_policy.mode`.

## Usage
```bash
personaxis state show   -f <state.json>
personaxis state init   -f <state.json>
personaxis state mutate -f <state.json> --field <dotpath> --delta <n> --reason "<why>"
```

## Clamping
A mutation is clamped to the declared `mean ± range`; the `mutation_log` records
`clamped: true` whenever the requested delta exceeded the envelope. Virtue/safety fields are
governance-gated.

## Example
```bash
personaxis state mutate -f state.json --field mood.tone --delta -0.10 --reason "smoke test"
```
