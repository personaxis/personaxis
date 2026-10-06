# `personaxis validate`

Validate a `personaxis.md` against the JSON Schema and the semantic universals. Returns one
of five statuses with mapped exit codes.

## Usage
```bash
personaxis validate [file] [--all]
```

With no file it validates `.personaxis/personaxis.md`; a sub-persona slug works too; `--all`
validates the root and every sub-persona.

## Statuses → exit codes
| Status | Code | Meaning |
|---|---|---|
| `PASS` | 0 | All MUST present, all universals satisfied. |
| `PASS_WITH_WARNINGS` | 0 | Missing SHOULDs / near-universal recommendations. |
| `FAIL_SCHEMA` | 1 | A MUST field is absent or wrong type (Ajv). |
| `FAIL_POLICY` | 2 | A universal policy invariant is violated. |
| `FAIL_CONCEPTUAL` | 3 | A prohibited claim or wrong universal constant. |

The 12 universals (e.g. `affect.regulation_policy.never_claim_real_feeling === true`,
safety weight ≥ 0.90, the three literal hard limits) are enforced on every run. Error
output names the exact failing field and rule.

## Every issue carries its remedy

Every issue prints a `fix` line naming the value to set, not the rule:

```
✗ apiVersion, U1: apiVersion must be exactly 'personaxis.com/v1'.
  fix: Set apiVersion: personaxis.com/v1 in the frontmatter.
```

Ajv's own phrasing is translated on the way out: `must be equal to constant` becomes the
constant it wants, and a conditional (`if`/`then`/`anyOf`) failure says it is the consequence
of a sibling error instead of asking you to satisfy `'if'`. A missing top-level field is
reported by its NAME, not by the schema's internal path.

## Example
```bash
personaxis validate .personaxis/personaxis.md
personaxis validate .personaxis/personas/cmo/personaxis.md
```
