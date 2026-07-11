# `personaxis diff`

Compare two `PERSONA.md` files **field by field** and report what changed, including **breaking
changes** (e.g. a required layer removed). A good CI gate for persona edits.

```bash
personaxis diff old/PERSONA.md new/PERSONA.md            # human-readable
personaxis diff old/PERSONA.md new/PERSONA.md --format json   # for CI
```

| Arg / flag | Meaning |
|---|---|
| `<before>` `<after>` | The two `PERSONA.md` files to compare. |
| `--format <text\|json>` | Output format (default `text`). |

Pairs with [`validate`](./validate.md) (is the new one valid?) and [`export`](./export.md) (clean form).
