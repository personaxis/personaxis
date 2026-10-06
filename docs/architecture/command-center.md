# Command Center

One surface to see and manage everything at every level, down to one coordinate of one persona:
this machine, a project, a persona, a layer, a field. It is what `personaxis menu` and `/menu` open.
The code is in `packages/cli/src/center/`; the commands are [`menu`](../commands/menu.md) and
[`console`](../commands/console.md).

## The model

Every manageable thing is a node with the same shape, so adding a capability means adding a node, not
a screen (`center/tree.ts`):

```
ScopeNode {
  level:  machine|global|activity|project|persona|identity|layers|layer|field|state|drift|evolution|model
  id, title, path[]              // path = breadcrumb ids, and the external address
  attributes: Attr[]             // what it reads (value + origin or note)
  actions:    Action[]           // what you can do (kind + effect + authority)
  children(): ScopeNode[]        // lazy: entering a node computes its children
  live?:      { instances, summary }   // presence, for persona and instance nodes
}
Action.effect ∈ navigate | direct | proposal | blocked
```

The tree is plain data with no Ink in it, so the TUI and the `console` command render and serialize
the same model. Every screen can answer where you are (the breadcrumb path), what the current node
acts on, and what Enter does (the node's declared actions).

```
machine (this host)
├─ activity            live instances across every registered persona
├─ global settings     default model, scanRoots, telemetry, writeLease
└─ project[]           from registry.json, only roots with a persona
   └─ persona (main)
      ├─ layers → layer (personality, affect, ...) → field (one envelope coordinate)
      │            field: current, range, half_life; edit action (blocked if protected)
      ├─ evolution   pending proposals
      ├─ state · drift · memory · skills · hooks · permissions · model
      └─ persona (@sub)   recursive: a sub is another persona node
```

It reuses `repl/scope.ts` (`settingFor`, `hostsFor`, `projectRootOf`) for effective configuration, and
from `@personaxis/core` `loadRegistry`, `livePresence`, `extractEnvelopes`, `readState` and
`proposals`.

## Permissions

Every write action resolves its authority in the order the spec sets (`center/authority.ts`, which
wraps the engine's `editGate`):

1. Hard limits and protected paths make the action `blocked` (a coordinate a hard virtue backs is
   read-only).
2. Governance (`improvement_policy.mode` and the per-layer edit policy): `locked` blocks,
   `suggesting` turns Enter into a governed proposal, `autonomous` applies it directly.
3. Configuration ownership (global, project or persona, through `settingFor`): a value is editable at
   its own layer, with its origin shown.

## Live activity

The navigator polls `livePresence` about once a second (frozen by `PERSONAXIS_NO_ANIM`) and renders a
live activity panel. It polls instead of listening for events because presence files arrive through
sync from other machines with no local event. Which surfaces report activity is in
[presence](./presence.md).

## Outside the TUI

`personaxis console ls|get|do <path> --json` serializes the same tree. `path` is the node's `path[]`
joined by `/` (`machine/<project>/main/layers/personality/<coordinate>`), so an agent drives the same
management surface without a terminal.

## Scope

Persona creation belongs to `/create`; the Command Center offers actions that delegate to it. It
reads governance and state and does not change the persona schema.
