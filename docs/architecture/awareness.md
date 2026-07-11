# Awareness: structural self-knowledge at runtime

A persona must know, at runtime, WHERE it sits and WHAT it has: whether it is the project
ROOT or a SUB-persona, its own hierarchical address, the sub-personas it can delegate to, and
the resources beside its spec. This is injected into the agent's system prompt every turn, 
it is NOT baked into the compiled `PERSONA.md`, which stays portable and purely qualitative.

Source: `packages/cli/src/repl/awareness.ts`; consumed by `packages/cli/src/repl/agent.ts`
(`AgentOptions.awareness`, folded into `systemPrompt`).

## What the block contains

`buildAwarenessBlock(personaPath)` assembles a `# Structure & resources` section with three
parts:

1. **Role + address.** Root vs sub is decided by `isSubagentPath`; a sub's hierarchical
   address comes from `slugAddressFromPath` (e.g. `cmo`, `cmo/legal`). A sub is told it is an
   independent persona with its own spec/state/memory/ledger that may READ other personas'
   files but only WRITE within its own folder; the root is told the inverse.
2. **Sub-personas to delegate to.** `discoverTree(personaPath)` enumerates the delegable
   tree, this works for **any** persona, not just the root, so a sub that has its own subs
   sees them too. Rendered as an indented `- @address` list (also `@all`, `@parent/all`).
3. **Resource inventory.** `buildResourceManifest(dirname(personaPath))` lists the supporting
   resources beside the spec (`.personaxis/` for the root, `.../personas/<slug>/` for a sub).

## Why inject, not compile

The block is rebuilt and injected into the system prompt each turn rather than baked into
`PERSONA.md`. The compiled doc stays a portable, purely qualitative character document (see
[compile.md](./compile.md)); structural facts (address, current sub-tree, resource list) are
runtime-derived and change as the project layout changes, so they belong in the prompt, not
the artifact.
