# `personaxis push` / `personaxis pull`

Publish or fetch a persona **version**: the spec (`personaxis.md`) + the compiled document +
the resource bundle (`memory.md`, `references/`, `examples/`, `skills/`, `assets/`).

## Usage
```bash
personaxis push [slug]      # publish the current version
personaxis pull <ref>       # fetch a published version
```

`push` recompiles the sibling compiled doc so spec and prose stay in sync, and records
provenance + content hashes in `manifest.json`. Use these to share governed personas across
projects/teams.
