# `personaxis console`

Headless access to the Command Center **scope tree** for coding agents and CI. It serializes the
same tree the interactive navigator (the default `personaxis menu` view) renders, so one model backs both:
browse it, read a node, or run an action, without a TUI.

```bash
personaxis console ls  <path>                 # a node's children
personaxis console get <path> [--json]        # a node's attributes + actions
personaxis console do  <path> <action> [value]  # run an action (honors the authority)
```

## Paths

A path is the node's id-path, `/`-separated:

```
machine                                   # this machine
machine/<project>                         # a registered project
machine/<project>/main                    # its main persona (or @<sub>)
machine/<project>/main/layers/<layer>/<coord>   # one envelope coordinate
```

`machine/*` needs the project registry (projects register themselves as you use them). To target
a persona you already know, without the registry, pass `--persona <path-to-personaxis.md>`; paths
then start at `main`:

```bash
personaxis console ls  main --persona .personaxis/personaxis.md
personaxis console do  main/layers/personality/personality.traits.openness edit 0.6 --persona .personaxis/personaxis.md
```

## `do` and the authority

Every action carries an effect the tree resolved from governance (see the Command Center PRD):

- **editable** (`direct`) → the edit applies immediately, envelope-clamped (a numeric coordinate
  becomes an `adjust`).
- **→ review** (`proposal`) → the edit queues as a governed proposal.
- **read-only** (`blocked`) → refused. `do` exits non-zero and names why (a hard virtue backs the
  coordinate, or the safety floor covers the layer).

`--json` on `get`/`do` gives machine-readable output for an agent to parse.

## Related

- `personaxis menu` — the same tree, interactive (the navigator is the default view).
- [command-center.md](../architecture/command-center.md) — the model and the authority rules.
