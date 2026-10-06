# `personaxis migrate`

Apply version-to-version codemods to a `personaxis.md`. Every bump except `0.10-to-1.0` is
additive: a persona at the previous version validates unchanged. Some bumps write a report
under `.personaxis/migrations/`.

## Usage
```bash
personaxis migrate <a-to-b> [file] [--apply]
```
Without `--apply` it is a dry run (prints what would change).

## Codemods
| Codemod | Effect |
|---|---|
| `0.5-to-0.6` / `0.6-to-0.7` | Layout + governance unification (with written reports). `0.6-to-0.7` also takes `--provider` for its first compile. |
| `0.7-to-0.8` | Bump only; new OPTIONAL fields become available (capabilities, permissions, …). |
| `0.8-to-0.9` | Bump only; verification / agent_budget / observability become available. |
| `0.9-to-0.10` | Bump only; `identity.short_name`, inline `improvement_policy.mode`, and the `persona_prompting` block become available. |
| `0.10-to-1.0` | **Breaking, structural, comment-preserving:** renames `reflexive_self_regulation`→`self_regulation`, folds `persona_prompting` into layer-10 `persona`, collapses the five refusal surfaces to two, moves memory retrieval knobs → `runtime.memory`, converts drive `intensity`→`level`, drops `metadata.display_name`, bumps `apiVersion`→`personaxis.com/v1`, and renames sibling `state.json` keys to full dot-paths. Writes a report under `.personaxis/migrations/`. |

## Example
```bash
personaxis migrate 0.10-to-1.0 .personaxis/personaxis.md --apply
personaxis validate .personaxis/personaxis.md     # confirm PASS
```
