# `personaxis memory`, what a persona remembers

```bash
personaxis memory                          # kinds, counts and files
personaxis memory --json
personaxis memory -p .personaxis/personas/legal/personaxis.md
```

Lists each memory kind the spec enables (`memory.types`), how many entries it holds and
which file backs it. A kind the spec disables is reported as disabled rather than hidden,
so "this persona has no episodic memory" and "this persona was never asked to keep one" are
distinguishable.

Editing and consolidation are interactive (`/memory` in the session opens each kind in your
editor); this door is for reading, which is what an agent or a CI check needs.

| Flag | Effect |
|---|---|
| `-p, --persona <path>` | which persona to inspect (default: the one in scope) |
| `--json` | emit JSON: every kind with `enabled`, `count`, `file` |
