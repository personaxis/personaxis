---
title: Command Center architecture (V9)
version: 1.0.0
date: 2026-07-22
status: draft
component: packages/cli/src/center/
---

# Command Center

A single surface to see and manage everything, at every level, down to one coordinate of one
persona: this machine → a project → a persona → a layer → a field. This is the design contract;
the phased build is `plan/MASTER_PLAN_2026-07-21.md` PARTE G.

## The problem it replaces

The previous Command Center (`packages/cli/src/command-center.tsx`, ~950 lines) was a flat
launcher: eight sibling sections (`home|model|state|drift|audit|memory|proposals|fleet`) wrapping
existing views. Its Fleet "drill" did not enter anything (it printed a `personaxis --persona <path>`
hint). There was no machine or project level, no per-component editing, no permissions, and its
"real time" was a lie (the presence `activity` field was only ever written `"idle"`). You could be
three screens deep with no way to tell whether you were configuring one persona, one project, or
the whole machine.

## Requirements

- **R1. One tree, one shape.** Every manageable thing is a node with the same interface, so adding
  a capability is a node, not a screen.
- **R2. Always answer three questions from the node itself:** where am I (breadcrumb path), what
  does this act on (the node), what does Enter do (the node's declared actions).
- **R3. Depth to the field.** Editing must reach a single coordinate (a trait mean), with its
  envelope, current value, and whether it is protected.
- **R4. Permissions are resolved, not guessed.** Every write action carries its authority and an
  effect (`direct` / `proposal` / `blocked`), derived from the spec and governance.
- **R5. Real-time truth.** Show what each running instance is actually doing, live.
- **R6. Pure model, two front-ends.** The tree is Ink-free data, so the TUI and an external
  `console` command render/serialize the same model.

## The model (built: `packages/cli/src/center/tree.ts`)

```
ScopeNode {
  level:  machine|global|activity|project|persona|identity|layers|layer|field|state|drift|evolution|model
  id, title, path[]              // path = breadcrumb ids, and the external address
  attributes: Attr[]             // what it READS (value + origin/note)
  actions:    Action[]           // what you can DO (kind + effect + authority)
  children(): ScopeNode[]        // LAZY: entering a node computes its children
  live?:      { instances, summary }   // presence, for persona/instance nodes
}
Action.effect ∈ navigate | direct | proposal | blocked
```

### Node catalog

```
machine (this host)
├─ activity            live instances across every registered persona (R5)
├─ global settings     default model, scanRoots, telemetry, writeLease            (G.3)
└─ project[]  (from registry.json, only roots with a persona)
   └─ persona (main)
      ├─ layers → layer (personality, affect, …) → field (one envelope coordinate)
      │            field: current, range, half_life; edit action (blocked if protected)
      ├─ evolution   pending proposals                                            (G.3/J.3)
      ├─ state · drift · memory · skills · hooks · permissions · model            (G.3)
      └─ persona (@sub)   recursive: a sub is another persona node
```

### What it reuses (no reinvention)

- `packages/cli/src/repl/scope.ts` — `settingFor`/`EffectiveSetting` (value + origin, owned vs
  inherited), `hostsFor`, `projectRootOf`. The effective-config resolution the settings facets need.
- `@personaxis/core` — `loadRegistry` (projects), `livePresence`/`describePresence` (R5),
  `extractEnvelopes` (the layer→field coordinates + `protectedFields`), `readState`, `proposals`,
  `displayName`.
- `packages/cli/src/repl/views/tabbed.tsx` — the drill-with-breadcrumbs host, the navigator pattern.

## Permissions model (G.3, next)

Every write action resolves its authority in the spec's order:

1. **Hard limits / protected paths** → `blocked`, read-only (already wired at the field level:
   a coordinate a hard virtue backs is `blocked`).
2. **Governance** (`improvement_policy.mode` + per-layer edit policy): `locked` → blocked;
   `suggesting` → `proposal` (Enter queues a governed proposal); `autonomous` → `direct`.
3. **Config-layer ownership** (global/project/persona via `settingFor`): editable at its own layer,
   with origin shown (owned vs inherited).

## Real-time model (G.2)

Producers (turn / loop / tasks / serve / compile) publish a meaningful `activity` (today only
`"idle"` is written). The navigator polls `livePresence` on a ~1s interval (frozen by
`PERSONAXIS_NO_ANIM`) and renders a live activity panel. Polling, not an event bus, because
presence files arrive via sync from other machines with no local event.

## External parity (G.5)

Because the tree is data, `personaxis console ls|get|do <path> --json` serializes it: `path` is the
node's `path[]` joined by `/` (`machine/<project>/main/layers/personality/<coordinate>`). An agent
drives the same management surface headlessly.

## Non-goals

- Not a persona CREATOR: `/create` owns the wizard; the Center offers "create sub here / register
  project" as actions that delegate.
- No new spec field: the Center READS governance/state; nothing here changes the persona schema.

## Build status (V9)

- **G.1 done**: the scope tree (`center/tree.ts`), machine → project → persona → layer → field over
  real data, sub-persona recursion, field-level protection. `test/center-tree.test.ts`.
- **G.3 done**: action authority (`center/authority.ts`, wraps the engine's `editGate`), the
  Permissions facet. `test/center-authority.test.ts`.
- **G.2 done (producer)**: the REPL turn publishes real activity (`noteActivity`, `ctx.presence`),
  the tree's `activityNode` renders it. `test/presence-activity.test.ts`. (Loop/tasks/serve
  announcing activity is a follow-up.)
- **G.4a/b done**: the recursive navigator (`center/navigator.tsx`) with breadcrumb, effect badges,
  drill, and inline field editing wired to the SDK (`center/run.tsx` `applyNavigatorEdit`). Reachable
  as the default `personaxis menu` view (G.4c made the navigator the default; `--classic` keeps the
  sectioned hub). `test/center-navigator.test.tsx`, `test/center-run.test.ts`.
- **G.5 done**: the external `console` (`commands/console.ts`, `center/edit.ts`) serializes the same
  tree for agents: `ls`/`get`/`do`, honoring authority, `--persona` to target without the registry.
  `test/console.test.ts`.
- **G.6 done**: consolidation audit (the surface was already consolidated in V7/V8; the docs index
  drift was fixed and pinned by a test).
- **G.4c done (closes V9)**: the navigator is the DEFAULT `/menu` (and `personaxis menu`), swapped
  at the command level so the legacy `CommandCenter` component is untouched. The classic sectioned
  hub (model wizard, config, views) stays reachable via `--classic` / `--section` and `/model` /
  `personaxis config`, so the model wizard never regressed. A fuller integration (the legacy
  sections as node `run` actions inside the navigator) is an optional follow-up.

**V9 is complete.** Follow-ups: loop/tasks/serve publishing live activity (G.2b), and the legacy
sections as in-navigator node actions (G.4d).
