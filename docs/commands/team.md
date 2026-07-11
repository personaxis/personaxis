# `personaxis team`

Operational multi-agent **teams**: a lead + members with **roles** and a shared **goal**. Distinct
from overseer *collections* (which are just a grouping/taxonomy); a team is operational and drives
[`orchestrate --team`](./orchestrate.md).

```bash
personaxis team create eng --lead architect     # create a team, optionally with a lead persona
personaxis team add eng reviewer --role qa       # add a persona with a role
personaxis team goal eng "ship the v1 API safely"
personaxis team show eng                          # or `team show` for all teams
```

| Subcommand | Meaning |
|---|---|
| `create <name> [--lead <slug>]` | Create a team, optionally with a lead. |
| `add <name> <slug> [--role <r>]` | Add a persona to the team with a role. |
| `goal <name> <goal…>` | Set the team's shared goal. |
| `show [name]` | Show one team, or all teams. |

Stored in the local registry (`~/.personaxis/registry.json`). See [overseer.md](./overseer.md)
(collections vs teams) and [orchestrate.md](./orchestrate.md).
