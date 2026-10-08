# Compile and decompile

Source: `packages/cli/src/commands/{compile,decompile}.ts`,
`packages/cli/src/{compile-instructions.ts, targets/placement.ts}`.

## Compile (`personaxis.md` → compiled doc)

A model writes the document, provider-agnostic (`local | byok | agent`); without one, `compile`
refuses and says how to configure one. Input: the full `personaxis.md` and a **reference** the code
assembles from it (`packages/core/src/compile/assemble.ts`): every hard limit, stay-in-character
rule, always/never anchor, consistency line and memory or resource path, plus how each trait
expresses at the current state. Output: the persona-prompting document (`PERSONA.md`).

The prompt (`compile-instructions.ts`) asks for the work first, traits only as they change how the
work is done and never as labels or levels, the reason for a rule where the spec gives one, the
spec's voice exemplars word for word, a normal tone, and only the reference's headings. The
faithfulness check (`packages/core/src/compile/faithfulness.ts`) then holds the document to the
reference: no protected bullet dropped, none added, no new heading. A rejected document goes back
with its findings and its own text, twice; after that `compile` stops, writes nothing, and keeps the
last attempt in `.personaxis/.tmp/rejected-PERSONA.md`. The reference itself is never written as a
persona's document.

**Canonical output paths** (see [multi-persona.md](./multi-persona.md)):
- root → `<repo>/PERSONA.md` (one level above `.personaxis/`); also injects `@PERSONA.md`
  into `CLAUDE.md`/`AGENTS.md`.
- sub → `.personaxis/personas/<slug>/PERSONA.md` (inside its folder).
- `--platform claude-code|codex|openclaw|hermes` also writes that host's placement (see
  [agent-adoption](./agent-adoption.md)).

Resource paths in the compiled doc are relative to where it lives: `./` for an in-folder sub,
`./.personaxis/` for the root.

### The compiled doc is purely qualitative (no runtime state)

`PERSONA.md` carries character and behavior only, never runtime numbers. The compile prompt
enforces this (`compile-instructions.ts`):

- No numeric state: "never include runtime numbers, trait/affect tables, sigil seeds, or
  a 'live state' block. The compiled document is purely qualitative; state lives in
  `state.json`."
- One source per fact: each fact, rule, trait, or limit appears in exactly one section;
  the only permitted restatement is a hard limit (referenced, not repeated).

A state change reaches a host through a `.live.json` marker beside the persona, not through the
prose: `liveSync` (`packages/core/src/live-sync.ts`) writes the marker (state hash, counts and
current values) and strips any residual `LIVE-STATE` block from older documents (`stripLiveBlock`).
The strip is idempotent.
See [self-evolution.md](./self-evolution.md) for how the active overlay (applied governed
self-edits) folds into compile as authoritative overrides.

Every written version goes into the persona's record as a `compiled` entry (the document's hash, why
it was written, the hash of the definition it came from, the model), and its text is kept once per hash
in `compiled/<hash>.md` (`packages/core/src/compile/history.ts`). A model writes the document, so two
compiles of one definition differ, and only this says which one an agent read.

When a coordinate crosses a band mid-session, the session marks `PERSONA.md` stale and starts the
same `compile` in the background, quiet and one at a time (`packages/cli/src/repl/session.ts`); the
turn does not wait, and every turn reads the document from disk, so the next one sees the rewrite. A
failed rewrite leaves the mark for the next crossing or `compile --if-pending`. The reference both
paths build carries the resource manifest, and the faithfulness check rejects a document that drops
a "Memory & resources" line, which is what a 2026-09-14 rewrite lost.

## Decompile (edited compiled doc → proposed `personaxis.md`)

Reverse direction for hand-edits: maps prose changes back to spec fields, including
persona-prompting (voice → `voice_exemplars`, situations → `scene_contracts`, Always/Never →
`behavioral_anchors`, staying-in-character → `break_character_guardrails`). It never weakens a
safety universal. The result is re-validated before anything is written.

What a compiled persona may do at run time (sandbox postures and permissions) is in [sandbox](./sandbox.md).
