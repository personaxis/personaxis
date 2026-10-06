# Compile and decompile

Source: `packages/cli/src/commands/{compile,decompile}.ts`,
`packages/cli/src/{compile-instructions.ts, targets/placement.ts}`.

## Compile (`personaxis.md` → compiled doc)

LLM-based, provider-agnostic (`local | byok | agent`). Input: the full
`personaxis.md` (+ `policy.yaml`/`state.json` as reference + a capped resource manifest).
Output: the persona-prompting document (`PERSONA.md`).

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

When a coordinate crosses a band mid-session, the living loop rewrites `PERSONA.md` in place.
That rewrite is the same document `compile --no-polish` writes: the resource manifest, the
sub-persona header and the skill list included. Both paths ask one function for it
(`packages/cli/src/compiled-document.ts`), and a test holds the session's hook to a real compile
byte for byte. What the rewrite does not do is what only `compile` does: polish the prose with a
model, and copy skills into a host's discovery directory.

## Decompile (edited compiled doc → proposed `personaxis.md`)

Reverse direction for hand-edits: maps prose changes back to spec fields, including
persona-prompting (voice → `voice_exemplars`, situations → `scene_contracts`, Always/Never →
`behavioral_anchors`, staying-in-character → `break_character_guardrails`). It never weakens a
safety universal. The result is re-validated before anything is written.

What a compiled persona may do at run time (sandbox postures and permissions) is in [sandbox](./sandbox.md).
