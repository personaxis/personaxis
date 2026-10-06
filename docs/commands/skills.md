# `personaxis skills`

Inspect and pull the skills a persona declares in `extensions.skills`. Every pulled skill is
security-reviewed first.

```bash
personaxis skills list                       # skills declared + their materialization status
personaxis skills pull <name>                # pull a `github:org/repo[/path]` skill into ./skills/<name>
personaxis skills list <slug>                # for a sub-persona
```

| Subcommand | Meaning |
|---|---|
| `list [slug]` | List `extensions.skills` entries and whether each is materialized. `--root` uses the root persona (the default). |
| `pull <name> [slug]` | Pull a `github:` skill into `./skills/<name>`, validate it, rewrite the entry to the local path. `--root` uses the root persona; `-y, --yes` rewrites `extensions.skills` without prompting. |

Skills materialize into the host's discovery dir on `compile` (`.claude/skills/` or `.agents/skills/`)
with a `skills-manifest.json`. Security scanning reuses the same engine as [`scan`](./scan.md).

## What a skill does when the persona runs here

Skills materialize for other hosts on `compile`. When the persona works in this engine (the TUI,
an editor over ACP or a [service step](./service.md)), it also uses the skills it declares on its
own. Nobody has to name a skill in a message.

- The persona sees an index. Every turn, its runtime context lists each skill with the
  `description` from its `SKILL.md`. That line is how the persona decides a skill fits the task, so
  write it as what the skill does and when to use it.
- The persona loads a skill when it decides to, with the `use_skill` tool. Loading is a call:
  it crosses the gate like any read, and what comes back names the version of the file it read and
  the files that come with the skill.
- What it used stays in the record. Every call the gate judged is written to the persona's
  record with its verdict, and a call that loaded a skill, or read a file from the persona's own
  `references/`, `examples/` or `assets/`, names it, a skill with the version it loaded. So whether a
  piece of work leaned on a source is something you can check afterwards, not the persona's word.
- Only local skills. A `github:` or `@org/name` entry is a pointer to something that is not on
  this disk, and a run never fetches it. Pulling one is `skills pull`, with its review.
- The instructions reach the model as quoted material, attributed and said to advise rather
  than authorise. A `SKILL.md` is text the persona did not write, so it never speaks with the
  persona's voice, and what stops a bad call is the gate, which runs whatever the skill said.
- `allowed-tools` in a skill is kept for hosts that read it; this engine does not use it to narrow
  the tool list.

So when a declared skill seems to do nothing, check two things: that its `description` says when to
use it, and that its `SKILL.md` is on disk, since a missing one is listed as unavailable.

## In the TUI

`/skill` opens the miniapp, with one sub-navbar entry per persona (main and every sub), so
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
