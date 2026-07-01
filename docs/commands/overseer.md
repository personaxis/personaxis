# `personaxis overseer`

The overseer is an **optional local registry** that gives you one situational view of every persona,
project, collection, team, and machine in your environment. It lives at `~/.personaxis/registry.json`
(override the dir with `PERSONAXIS_HOME`).

> **Be honest about what this is.** It is **not** part of the default flow and is **empty until you
> populate it manually**. Nothing writes to it automatically during a normal REPL session — you opt
> in. Its payoff is `personaxis orchestrate`, which routes a task across the personas you
> registered here.

## Not the online registry

This local registry is **separate** from the online one. [`push` / `pull`](./push-pull.md) publish and
fetch persona **versions** to/from the hosted registry at personaxis.com; the overseer registry is a
private, machine-local index of what you have. Different store, different purpose — don't conflate them.

## Subcommands

| Command | What it does |
|---|---|
| `personaxis overseer show [--json]` | Print the view: counts + a list of personas, projects, collections, teams. |
| `personaxis overseer register <slug...>` | Register the **current project** and its persona slug(s), tagged with this machine. |
| `personaxis overseer collection <name> [--add-persona <slug>] [--add-project <path>]` | Create a collection (a grouping/taxonomy) and add members. |

Related surfaces that write the same registry: [`personaxis personas import <path>`](./personas.md)
registers a reusable **global** persona; the REPL's `/overseer` shows the same view.

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

`orchestrate` reads the **registered** personas' global specs, derives each one's capabilities, and
assigns the task to the top match (capability-ranked, optionally scoped to a `--team`). With no
registered personas it tells you to run `overseer register` first — which is exactly why the registry
is opt-in: it exists to power orchestration, not to track your day-to-day REPL use.

## See also

- [personas.md](./personas.md) — the global-persona reuse model that seeds the registry.
- [architecture/deployment.md](../architecture/deployment.md) — where the overseer sits relative to the engine.
