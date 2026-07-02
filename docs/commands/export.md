# `personaxis export`

Export a compiled `PERSONA.md` to a **clean, machine-readable format** — semantic content only, with
the pedagogical comments and empty fields stripped. Useful for publishing, indexing, or feeding another
tool.

```bash
personaxis export                              # ./PERSONA.md → stdout (default: json)
personaxis export ./PERSONA.md --format yaml
personaxis export --format md -o dist/persona.md
```

| Arg / flag | Meaning |
|---|---|
| `[file]` | Path to `PERSONA.md` (default `./PERSONA.md`). |
| `--format <json\|md\|yaml>` | Output format. |
| `-o, --out <path>` | Write to a file instead of stdout. |

For the reverse (edit → fold back into the spec) use [`decompile`](./decompile.md); to compare two
versions use [`diff`](./diff.md).
