# `personaxis personas`

Manage the **global** persona registry (`~/.personaxis/personas/<slug>/`) so the same identity
can be reused across projects, with a per-project overlay (`state.json`) so each project keeps
its own runtime state.

## Usage
```bash
personaxis personas list
personaxis personas import <path>
personaxis personas use <slug>
```

Distinct from project-local **sub-personas** (`.personaxis/personas/<slug>/`, addressed with
`@slug` in the REPL, see [../architecture/multi-persona.md](../architecture/multi-persona.md)).
