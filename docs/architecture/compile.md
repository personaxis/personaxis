# Compile / decompile, and the sandbox model

Source: `packages/cli/src/commands/{compile,decompile}.ts`,
`packages/cli/src/{compile-instructions.ts, targets/placement.ts}`,
`packages/core/src/sandbox.ts`.

## Compile (`personaxis.md` → compiled doc)

LLM-based, provider-agnostic (`local | byok | agent | remote`). Input: the full
`personaxis.md` (+ `policy.yaml`/`state.json` as reference + a capped resource manifest).
Output: the persona-prompting document (`PERSONA.md`).

**Canonical output paths** (see [multi-persona.md](./multi-persona.md)):
- root → `<repo>/PERSONA.md` (one level above `.personaxis/`); also injects `@PERSONA.md`
  into `CLAUDE.md`/`AGENTS.md`.
- sub → `.personaxis/personas/<slug>/PERSONA.md` (inside its folder).
- `--platform claude-code|codex` → ALSO exports the host placement.

Resource paths in the compiled doc are relative to where it lives: `./` for an in-folder sub,
`./.personaxis/` for the root.

### The compiled doc is purely qualitative (no runtime state)

`PERSONA.md` carries character and behavior only — never runtime numbers. The compile prompt
enforces this (`compile-instructions.ts`):

- **NO NUMERIC STATE** — "never include runtime numbers, trait/affect tables, sigil seeds, or
  a 'live state' block. The compiled document is purely qualitative; state lives in
  `state.json`."
- **ONE SOURCE PER FACT** — each fact, rule, trait, or limit appears in exactly one section;
  the only permitted restatement is a hard limit (referenced, not repeated).

State drift reaches a host through a `.live.json` notify marker beside the persona, not the
prose: `liveSync` (`packages/core/src/live-sync.ts`) writes the marker (state hash + counts +
current values) and **self-heals** older docs by stripping any residual `LIVE-STATE` block
(`stripLiveBlock`). Earlier versions injected a numeric live-state table into `PERSONA.md`;
that injection is gone, and the strip is idempotent so stale tables disappear on next sync.
See [self-evolution.md](./self-evolution.md) for how the active overlay (applied governed
self-edits) folds into compile as authoritative overrides.

## Decompile (edited compiled doc → proposed `personaxis.md`)

Reverse direction for hand-edits: maps prose changes back to spec fields, including
persona-prompting (voice → `voice_exemplars`, situations → `scene_contracts`, Always/Never →
`behavioral_anchors`, staying-in-character → `break_character_guardrails`). It never weakens a
safety universal. The result MUST be re-validated before writing.

## Sandbox & permissions — what actually enforces (Implemented + best-effort)

Two layers (`sandbox.ts`):

1. **Policy decision (load-bearing, fully tested).** `evaluateCommand` / `evaluateFileWrite`
   return `allow | ask | deny` with precedence **deny-list > sandbox hard limits > allow-list
   > approval mode**. A denied op never runs. The three sandbox postures:
   - `read-only` — forbids writes + network.
   - `workspace-write` — blocks writes that escape the workspace + destructive commands.
   - `danger-full-access` — no wrapping (explicit opt-out).
   Plus the per-persona `permissions` block and the cross-persona deny rules
   ([multi-persona.md](./multi-persona.md)).
2. **Native wrapper (best-effort, OS-dependent).** When a command is allowed, it is wrapped
   with the platform sandbox where available: macOS **Seatbelt** (`sandbox-exec`), Linux
   **bubblewrap** (`bwrap`). **Windows has no portable kernel sandbox**, so there the
   guarantee is the policy decision (deny-by-default for risky ops), not kernel isolation —
   stated honestly rather than pretending otherwise.

Tests: `packages/core/test/sandbox.test.ts` (classification, the three postures, file-write
escapes, per-persona permissions).
