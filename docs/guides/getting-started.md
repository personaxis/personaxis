# Getting started: by audience

One toolchain, three doors. Everything below is local-first and BYOK: no account,
no daemon, plain git-versionable files.

## Developers (5 minutes)

```bash
# Until the next npm release, run from a clone (the repo is ahead of npm):
#   pnpm install && pnpm run build
#   alias personaxis="node $PWD/packages/cli/dist/index.js"
# After the release: npm i -g @personaxis/persona.md

personaxis proof --quick             # watch the guarantees hold before trusting them
personaxis create dev-buddy          # the interview builds a governed persona
personaxis --persona .personaxis/personas/dev-buddy/personaxis.md   # live REPL
```

In the REPL: `/state` (envelope values), `/drift` (where you are + what a change
costs), `/replay` (history as animation), `/arbitrate` (value conflicts),
`/improve suggesting` (allow governed self-proposals), `/dash` (live dashboard).

For coding agents: `personaxis compile --platform claude-code` places
`.claude/agents/<slug>.md`; `--platform codex` targets AGENTS.md/TOML. The persona
follows your repo, not a vendor.

## Teams & enterprises

1. **Author** the persona with `create` (the creation report is your review doc:
   every number has provenance; the "Defaults" section is the review checklist).
2. **Lock it**: `personaxis improve locked` (state still adapts inside envelopes;
   the SPEC cannot self-modify). Governance postures: locked → suggesting →
   autonomous, and a sibling `policy.yaml` can only make things stricter.
3. **Gate deploys**: `personaxis validate` (five exit states) and
   `personaxis state drift` (exit 2 past declared thresholds) in CI.
4. **Audit**: the mutation log and episodic memory are hash-chained;
   `personaxis state rebuild` proves state ≡ history; `proof` scenes 4–5 are the
   demo for your risk team. Right-to-erasure is supported without breaking chains.

## Creators (worlds, characters, brand voices)

Bring what you have: `personaxis create --from-import your-card.png` upgrades a
SillyTavern-style card into a governed persona; `--from-transcript` induces one
from example chats; the interview builds one from your answers. Per-vertical
starting points: [`recipes.md`](./recipes.md).

## Prompts & tips that pay off

- **The numbers are already load-bearing**: `create` synthesizes per-band
  `expression {low, moderate, high}` prose for every trait and affect coordinate, so
  `personaxis jacobian` shows zero decorative numbers out of the box. Tune the wording
  on the traits you care about; you are sharpening prose, not adding it.
- **Half-life for moods**: `half_life: 4` on mood coordinates gives you a persona
  that reacts AND recovers, with a provable ceiling on standing drift (δ_max/λ).
  Genesis already sets one where the evidence implies volatility.
- **Write briefs like evidence**: `create --from-prompt` keeps only what it can
  quote. "Never reveals sources; terse; warms up to regulars over weeks" beats
  "cool mysterious vibe".
- **The demo that lands**: `personaxis proof` first, then YOUR persona in the REPL
  with `/drift` after ten hostile turns. Bounded beats vibes.
- **When something looks wrong**: `validate` names the exact failing field;
  `state rebuild` repairs a torn state from its log; `personaxis-evals` runs the
  15-scenario conformance suite against your build.

## Where things live

```
.personaxis/personaxis.md        the quantitative spec (identity: version this)
PERSONA.md                       the compiled document agents actually read
.personaxis/state.json           mutable runtime state (envelope-clamped)
.personaxis/personas/<slug>/     sub-personas (same trio each)
creation-report.md               provenance of every number (Genesis)
memory/episodic.jsonl            hash-chained memory (tamper-evident)
```

Next: [`creating-personas.md`](./creating-personas.md) (which `create` door for which
input) · [`production.md`](./production.md) (deploy + CI gates + troubleshooting) ·
deeper: `docs/HOW_IT_WORKS.md` · spec: `personaxis spec` · guarantees:
`../GUARANTEES.md` · math: `../architecture/math-core.md`.
