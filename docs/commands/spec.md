# `personaxis spec`

Print an **embedded spec summary + lint rules** — handy to inject into an agent's context.

```bash
personaxis spec                 # the embedded summary
personaxis spec --rules         # + the lint-rules table
personaxis spec --rules-only    # only the rules
personaxis spec --format json
```

| Flag | Meaning |
|---|---|
| `--rules` | Append the lint-rules table. |
| `--rules-only` | Output only the rules. |
| `--format <text\|json>` | Output format. |

> ⚠️ The embedded text is a **summary (v0.6-era layers)**, not the normative spec. The current,
> authoritative spec (v0.10) lives at
> [`persona.md/docs/SPEC.md`](https://raw.githubusercontent.com/personaxis/persona.md/main/docs/SPEC.md)
> — prefer it for authoring. (`spec` prints a pointer to it.)
