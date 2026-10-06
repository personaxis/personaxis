# Awareness: what a persona knows about itself at runtime

At run time the agent's system prompt carries a `# Runtime context` block: whether the persona is
the project's main persona or a sub-persona, which files define it, what each thing it has is for,
and where its work goes. It is injected every turn and is not baked into the compiled `PERSONA.md`,
which stays portable and purely qualitative.

Sources: `packages/cli/src/repl/awareness.ts` builds the block; `packages/core/src/run/work-map.ts`
reads what the persona has; `packages/core/src/agent.ts` puts the block in the stable part of the
system prompt.

## What the block contains

`buildAwarenessBlock(personaPath)` assembles a `# Runtime context` section, in this order:

1. Who you are here. Main persona or sub-persona, decided by `isSubagentPath`; a sub-persona's
   hierarchical address comes from `slugAddressFromPath` (e.g. `cmo`, `cmo/legal`). A sub-persona is
   told it is an independent persona with its own spec, state, memory and ledger, that may READ other
   personas' files and only WRITE within its own folder; the main persona is told the inverse.
2. Your defining files. The spec, the compiled document and the state file, with the spec version.
3. This session. The project folder, the model answering, and the self-improvement mode.
4. What you have, and when to use it. The work map, an index with one line per thing that says
   what it is for:
   - Skills, with the `description` from each skill's own `SKILL.md`, and any declared skill that
     is not on disk, named as unavailable.
   - Services you deliver, with the files a run has to leave. A main persona sees every service in
     the workspace; a sub-persona sees the ones it leads or does a step of.
   - References, examples and assets, each with its first heading or first line.
   - Sub-personas you can hand work to, each with the purpose its spec declares.
   - Memory, the kinds this persona keeps, and that `memory_search` reaches them.
5. Where things go. Work happens in the workspace and deliverables are written there; the
   persona's own folder holds its definition, state, memory, skills and references, which it reads
   and does not rewrite; heavy material is read by path when the task needs it.
6. Your standing objective, last, when one is set, because the end of a prompt is where a model
   attends most.

Each section is capped (twenty items), and what does not fit is counted with where to find it, never
dropped without a word. The full text of a skill, a reference or an example stays on disk.

## What is left out

The block sits in the cached prefix, so nothing in it may move while a persona works.

- The sandbox posture. It changes when someone presses shift+tab, so it reaches the model every turn
  in its own "Right now" message instead.
- The session list. Naming every conversation file would change the prefix between turns; memory is
  reached with `memory_search` instead.
- Anything with a clock.

## Which turns receive it

Every surface that gives a persona a working turn: the TUI, an editor over ACP, a service step, and
the headless turn. A test checks each of them passes the block, because a turn from an editor used to
receive none of it.

The compiled document stays portable and purely qualitative (see [compile.md](./compile.md)). What a
persona has, and where its work goes, is read from disk when a session opens and changes as the
project changes, so it belongs in the prompt, not in the artifact.
