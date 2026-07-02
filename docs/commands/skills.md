# `personaxis skills`

Inspect and pull the **skills** a persona declares in `extensions.skills`. Every pulled skill is
**security-reviewed** first (≈26% of community skills carry risky patterns — never run an unreviewed one).

```bash
personaxis skills list                       # skills declared + their materialization status
personaxis skills pull <name>                # pull a `github:org/repo[/path]` skill into ./skills/<name>
personaxis skills list <slug>                # for a sub-persona
```

| Subcommand | Meaning |
|---|---|
| `list [slug]` | List `extensions.skills` entries and whether each is materialized. |
| `pull <name> [slug]` | Pull a `github:` skill into `./skills/<name>`, validate it, rewrite the entry to the local path. |

Skills materialize into the host's discovery dir on `compile` (`.claude/skills/` or `.agents/skills/`)
with a `skills-manifest.json`. Security scanning reuses the same engine as [`scan`](./scan.md).
