# `personaxis orchestrate`

Route a task to the **best-matched registered persona**, ranked by capability. Reads the personas you
registered with the [overseer](./overseer.md) (so populate that first).

```bash
personaxis orchestrate "draft the launch positioning"           # pick + show the best persona
personaxis orchestrate "draft the launch positioning" --run     # also run one governed Living-Loop cycle on it
personaxis orchestrate "review the auth code" --team eng         # restrict routing to a team's members
```

| Arg / flag | Meaning |
|---|---|
| `<task>` | The task description (capability-matched against registered personas). |
| `--team <name>` | Only consider members of that [team](./team.md). |
| `--run` | Run one governed tick on the assigned persona (otherwise just reports the match). |

With no registered personas it tells you to run `personaxis overseer register <slug>` first. See
[overseer.md](./overseer.md) for the registry model and [team.md](./team.md) for teams.
