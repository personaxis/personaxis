# `personaxis personas`

Manage the global persona registry (`~/.personaxis/personas/<slug>/`) so the same persona can
be reused across projects, with a per-project overlay (`state.json`) so each project keeps its
own runtime state.

## Usage
```bash
personaxis personas list                              # personas installed globally
personaxis personas import <path> [--slug <slug>]     # register a personaxis.md as a global persona
personaxis personas export <slug> <dest>              # copy a global persona out to a file
personaxis personas adopt <slug>                      # adopt it into this project, with its own state.json
```

Distinct from project-local **sub-personas** (`.personaxis/personas/<slug>/`, addressed with
`@slug` in the REPL, see [../architecture/multi-persona.md](../architecture/multi-persona.md)).
