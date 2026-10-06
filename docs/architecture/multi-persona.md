# Multi-persona: root + sub-personas

A project has one root persona (the repo-wide agent) and any number of sub-personas (specialists you
delegate to, by `@slug` or through the `delegate` tool). The layout mirrors itself one folder deeper
and recurses.

Source: `packages/cli/src/repl/{roster.ts, index.ts}`; `packages/cli/src/commands/compile.ts`.

## Layout (and why the compiled doc lands where it does)

```
<repo>/
  PERSONA.md                              ← root compiled doc (ONE level above .personaxis/)
  .personaxis/
    personaxis.md  state.json  memory.md  policy.yaml  …   ← root resources
    personas/
      cmo/
        personaxis.md  state.json  memory.md  …            ← sub resources
        PERSONA.md                        ← sub compiled doc (INSIDE its own folder)
        personas/                         ← a sub can have its own subs (recurses)
```

The root's compiled `PERSONA.md` sits at the repo root so a host agent reads it as the
project baseline; a sub's compiled `PERSONA.md` sits inside its folder next to its own
resources. `personaxis compile` resolves these automatically:

```bash
personaxis compile --root        # .personaxis/personaxis.md  → ./PERSONA.md
personaxis compile cmo           # .personaxis/personas/cmo/personaxis.md → …/cmo/PERSONA.md
personaxis compile cmo --platform claude-code   # also export .claude/agents/cmo.md (host)
```

## Addressing personas in the REPL (`@slug` / `@all`)

You talk to the root by default. To reach sub-personas, prefix the message:

- `@cmo tighten this positioning` → routes to the `cmo` sub-persona.
- `@cmo @legal review the claim` → routes to both, in turn.
- `@all status?` → every sub-persona.

Unknown `@tokens` (e.g. an email) are left in the message, never mis-routed. A reply comes
from the addressed persona: its own name and its own fixed color, not ventriloquized by
the root. Each sub runs with its own spec, compiled `PERSONA.md`, `state.json`, memory,
and self-improvement ledger; only the screen + the session context-meter are shared.

`@` addressing is a CLI-level convenience. When a persona is loaded by Claude Code or Codex, it is
compiled to that host's sub-agent convention (`.claude/agents/<slug>.md`,
`.codex/agents/<slug>.toml`), so there is no format collision; see
[agent-adoption.md](./agent-adoption.md).

## Root awareness

- The root's compiled system prompt is augmented with the list of sub-personas it can
  delegate to (`## Sub-personas you can delegate to`).
- Every delegation is recorded in the root's hash-chained memory
  (`Delegated to @<slug>: "…"`), so the root stays aware of what was done with whom.

## Isolation: read anything, write your own

Cross-persona files are read-only. `buildPolicy` adds deny-list regexes so a persona can
READ any other persona's files but never WRITE them (`crossPersonaDenies`):

- the root may write its own `.personaxis/` resources but is denied any write under
  `.personaxis/personas/`;
- a sub `<slug>` is denied any write under `.personaxis/personas/` except its own
  `…/<slug>/` subtree.

Deny has the highest precedence in the policy engine (`evaluateCommand` /
`evaluateFileWrite`), so the rule holds regardless of the sandbox posture. See
[sandbox](./sandbox.md) for the sandbox model and its OS limits.

## Per-persona colors

The root replies in the terminal's default foreground (white on dark, black on light).
Each sub gets a fixed, deterministic, non-repeating ANSI-256 color (`colorForSlug`),
derived from the slug hash with in-roster collision avoidance, so a persona looks the same
every session and two personas never share a color.

## Verify it yourself

```bash
# scaffold a sub, compile both, then run the REPL and address them:
personaxis create cmo               # creates .personaxis/personas/cmo/
personaxis compile --root && personaxis compile cmo
personaxis                          # @cmo …, @all …, watch colors + the 'delegated' memory
```
Tests: `packages/cli/test/roster.test.ts` (discovery, deterministic non-repeating colors).
