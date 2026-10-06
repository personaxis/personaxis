# `personaxis overseer`

The overseer is an optional local registry that gives you one situational view of every persona,
project, collection, team and machine in your environment. It lives at
`~/.personaxis/registry.json` (override the dir with `PERSONAXIS_HOME`).

Every command run inside a project registers that project, so the project list fills itself. The
personas, collections and teams are what you add yourself, and they are what
`personaxis orchestrate` routes a task across. Nothing in the registry leaves this machine.

## Subcommands

| Command | What it does |
|---|---|
| `personaxis overseer show [--json]` | Print the view: counts + a list of personas, projects, collections, teams. |
| `personaxis overseer register <slug...>` | Register the current project and its persona slug(s), tagged with this machine. |
| `personaxis overseer collection <name> [--add-persona <slug>] [--add-project <path>]` | Create a collection (a grouping/taxonomy) and add members. |

Related surfaces that write the same registry: [`personaxis personas import <path>`](./personas.md)
registers a reusable global persona; in the app, `/menu` shows the same view.

## Concrete walkthrough

You have two projects that share a `cmo` persona and want to route work across them:

```bash
# 1. Make cmo a reusable global persona (writes registry.personas).
personaxis personas import ./.personaxis/personaxis.md --slug cmo

# 2. Register each project against it (writes registry.projects, per machine).
cd ~/work/site   && personaxis overseer register cmo
cd ~/work/api    && personaxis overseer register cmo

# 3. (optional) Group them.
personaxis overseer collection growth --add-persona cmo --add-project ~/work/site

# 4. See the whole environment.
personaxis overseer show

# 5. The payoff: route a task to the best-matching registered persona.
personaxis orchestrate "draft the launch positioning" --run
```

`orchestrate` reads the registered personas' global specs, derives each one's capabilities, and
assigns the task to the top match (capability-ranked, optionally scoped to a `--team`). With no
registered personas it tells you to run `overseer register` first.

## See also

- [personas.md](./personas.md), the global-persona reuse model that seeds the registry.
- [architecture/deployment.md](../architecture/deployment.md), where the overseer sits relative to the engine.

## `overseer scan`, recovery only

```bash
personaxis overseer scan --root ~/Documents/GitHub   # ad hoc
personaxis overseer scan                             # over your configured scanRoots
```

The registry normally learns about your projects by use: every command registers the project
it runs in, so a persona you create, open, compile or diagnose is recorded at that moment.

The scan exists for projects that already existed before you started using the CLI, which were
never registered by use. Run it once; from then on registration by use keeps up.

It never runs automatically, only walks folders you name (`--root`, or `scanRoots` in your
config), is depth-limited, and skips `node_modules`, `.git` and build output. On finding a
project it stops descending, because sub-personas are read from the persona itself, not by
walking further.

Full rationale: [`docs/architecture/project-registry.md`](../architecture/project-registry.md).
