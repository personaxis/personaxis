# `personaxis spec`

Print the **current personaxis.md specification** (v0.10) plus the lint rules — handy to inject into an
agent's context so it authors valid personas.

```bash
personaxis spec                 # the full v0.10 spec
personaxis spec --rules         # + the lint-rules table
personaxis spec --rules-only    # only the rules
personaxis spec --format json
```

| Flag | Meaning |
|---|---|
| `--rules` | Append the lint-rules table. |
| `--rules-only` | Output only the rules. |
| `--format <text\|json>` | Output format. |

The spec text is the **byte-identical embedded copy of the normative spec**
([`persona.md/docs/SPEC.md`](https://github.com/personaxis/persona.md/blob/main/docs/SPEC.md)),
inlined at build time by `scripts/embed-assets.mjs` — so it is always the current spec and never goes
stale. (Any `v0.6`/`v0.7` mentions inside are the spec's own version-history sections.)
