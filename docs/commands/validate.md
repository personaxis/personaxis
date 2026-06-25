# `personaxis validate`

Validate a `personaxis.md` against the JSON Schema **and** the semantic universals. Returns one
of five statuses with mapped exit codes.

## Usage
```bash
personaxis validate <file>
```

## Statuses → exit codes
| Status | Code | Meaning |
|---|---|---|
| `PASS` | 0 | All MUST present, all universals satisfied. |
| `PASS_WITH_WARNINGS` | 0 | Missing SHOULDs / near-universal recommendations. |
| `FAIL_SCHEMA` | 1 | A MUST field is absent or wrong type (Ajv). |
| `FAIL_POLICY` | 2 | A universal policy invariant is violated. |
| `FAIL_CONCEPTUAL` | 3 | A prohibited claim or wrong universal constant. |

The 12 universals (e.g. `affect.regulation_policy.never_claim_real_feeling === true`,
safety weight ≥ 0.90, the three literal hard limits) are enforced in `src/schema.ts`. Error
output names the exact failing field/rule.

## Example
```bash
personaxis validate .personaxis/personaxis.md
personaxis validate .personaxis/personas/cmo/personaxis.md
```
