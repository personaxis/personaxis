# `personaxis skills`

Inspect and pull the **skills** a persona declares in `extensions.skills`. Every pulled skill is
**security-reviewed** first (≈26% of community skills carry risky patterns, never run an unreviewed one).

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

## What a skill does when the persona runs here

The line above is the way out, so another host can find the skill. There is also a way in: when the
persona works in this engine, a [service step](./service.md) included, it is handed the skills it
declares.

- **Only local skills.** A `github:` or `@org/name` entry is a pointer to something that is not on
  this disk, and a run never fetches it. Pulling one is `skills pull`, with its review.
- **The guide reaches the model as quoted material**, in its own message, attributed and said to
  advise rather than authorise. A `SKILL.md` is text the persona did not write, so it never speaks
  with the persona's voice, and what stops a bad call is the gate, which runs whatever the guide
  said.
- **Which skills apply is decided per task**, from the skill's name and its `description`. That is
  what the `description` field is for, so write it as when to use this.
- **`allowed-tools` narrows the tools offered**, and is optional. A skill that names none narrows
  nothing: saying nothing about tools is not saying that no tool is allowed.

So a `description` that does not say when the skill applies is a skill that never activates, and
that is the one thing worth checking when a declared skill seems to do nothing.

## In the TUI

`/skills` opens the miniapp, with one sub-navbar entry per persona (main and every sub), so
every action applies to the persona you are looking at:

| Key | Action |
|---|---|
| `Enter` | apply the selected skill |
| `a` | declare a new one (a local path, a `github:` ref, or `@org/name@version`) |
| `m` | materialize it (fetch/copy the files into place) |
| `u` | update it against its source |
| `d` | stop declaring it (files are kept) |
| `p` or `←`/`→` | switch persona |
| `Esc` | back |

`p` is the app-wide persona-switch key, the same one every other miniapp uses.
