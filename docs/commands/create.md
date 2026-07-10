# `personaxis create`: Genesis

Create a governed AI Persona from zero. Every entry case produces the same four
artifacts: a **validated** `personaxis.md` (Genesis cannot write an invalid persona,
property-tested), `state.json`, a stage-1 compiled `PERSONA.md`, and
`creation-report.md` with **per-number provenance**.

```bash
personaxis create                              # psychometric interview (TTY)
personaxis create --from-prompt "<brief>"      # natural language
personaxis create --from-project [dir]         # infer from the project's own docs
personaxis create --from-import card.png       # character card V2/V3 (.json/.png)
personaxis create --from-import CLAUDE.md      # system prompt / agent files
personaxis create --from-transcript chat.txt   # exemplar conversations
```

Modes **compose** (later evidence wins per field; overrides stay visible in the
report). `[slug]` names the persona (default: under `.personaxis/personas/<slug>/`;
`--root` writes the project's root persona).

| Flag | Effect |
|---|---|
| `--yes` | non-interactive: accept labeled defaults, overwrite existing |
| `--json` | emit spec + gates + provenance as JSON (dry-run unless `--yes`) |
| `--provider <p>` | override the provider for LLM extraction (`local\|byok\|agent\|remote`) |

**The interview** maps answers deterministically (item bank v1.0.0): Likert to
trait means, a confidence item to envelope widths, value ranking to weights,
dilemmas to hard limits / prohibited behaviors / cognitive strategy. Works fully
offline. **LLM extraction** (prompt/project/transcript/card-prose) requires every
number to carry an evidence quote; dimensions without evidence are omitted, never
invented; with no model, a labeled heuristic baseline is used and recorded.

**Every number is born load-bearing.** You never hand-write behavior prose. Genesis
fills each trait and affect coordinate with per-band `expression` text and, where the
evidence implies volatility, a `half_life`, so the value actually selects prose when
its band changes at compile time. The source of that prose is recorded per number:
`earned` (an evidence quote), `synthesized` (a deterministic construct table, rule
`construct-band-prose@v1`, same seed gives the same prose), or `default`. Volatility
cues like "quick to anger, slow to forgive" map to short and long half-lives on the
matching coordinates.

**Universals are not negotiable by input**: safety stays governance-typed at 0.98
and cannot be outranked; honesty stays hard; the three universal hard limits are
always present; envelopes are sanitized to `min ≤ mean ≤ max`.

Gates (all must pass before writing): five-state validate = PASS · lint · stage-1
compile · provenance completeness · **jacobian** (no decorative coordinate survives).
The jacobian gate compiles the persona at each band and rejects any mutable coordinate
whose value provably cannot change the compiled artifact; if Genesis finds one it
repairs it by synthesis and recompiles, and only a coordinate that cannot be made
load-bearing fails the gate (a bug, not a user error). The result: `create` in any
mode, with or without a model, produces zero decorative numbers, which you can confirm
with [`personaxis jacobian`](./jacobian.md). Exit codes follow the validator convention.

See: `docs/architecture/genesis.md` (design), `creation-report.md` (what to review;
its "Defaults" section lists every number NOT earned from evidence, and its provenance
table now distinguishes earned / synthesized / default per coordinate).
