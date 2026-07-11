# Running personas in production

Three integration surfaces, one engine. Deep dives:
[`architecture/deployment.md`](../architecture/deployment.md) (surfaces & modes),
[`integrations/`](../integrations/README.md) (per-host wiring),
[`configuration.md`](./configuration.md) (models/keys).

## Choose a surface

| Surface | When | How |
|---|---|---|
| **MCP** (`personaxis-mcp`) | Your agent host speaks MCP (Claude Code, Codex, Cursor) | stdio server, 16 tools (`persona_compiled`, `persona_observe`, `adjust_persona_state`, …). Confine paths with `--root`; `persona_decide_edit` needs the explicit `--allow-decide` flag (proposer ≠ approver). |
| **SDK** (`@personaxis/sdk`) | You own the backend | The `Persona` class is the whole engine façade (`observe` / `adjust` / `agentRun` / `audit` / `proposeEdit` / …). MCP and serve are thin hosts over it, embedding it gives you the same governance. |
| **HTTP** (`personaxis serve`) | Non-MCP agents / services | HTTP + `agents.md` low-context interop; run it next to the persona files. |

Compiled placement for coding agents: `personaxis compile --platform claude-code`
(`.claude/agents/<slug>.md`) or `--platform codex`. The persona ships with the repo.

## The four production controls

1. **Lock the posture**: `personaxis improve locked`, state still adapts inside
   envelopes; the spec cannot self-modify. `suggesting` queues proposals for human
   `/review`. A sibling `policy.yaml` can only make things **stricter**.
2. **Gate deploys in CI**:
   ```bash
   personaxis validate <spec>    # exit 0 only on PASS/PASS_WITH_WARNINGS
   personaxis state drift        # exit 2 once any layer exceeds its declared threshold
   pnpm run check-mirror         # if you vendor the schemas: byte-identity or fail
   ```
3. **Audit trail**: `mutation_log` and episodic memory are hash-chained;
   `personaxis state rebuild` proves state ≡ fold(log) and repairs a torn
   `state.json`; `/audit` in the REPL summarizes chain health. Right-to-erasure is a
   tombstone, the chain still verifies after real deletion.
4. **Keys and config**: BYOK via env (`PERSONAXIS_ENDPOINT` / `PERSONAXIS_MODEL` /
   key env-vars) or `personaxis config` (global/project/per-persona precedence).
   **Never commit API keys**; config files reference key *env names*, not values.

## Sizing & overhead

The governed tick is pure math, measured p99 **0.06–0.12 ms** per tick at 8–64
mutable coordinates (E4, the research bundle (E4 bench)). The
LLM appraiser is the only network hop and is optional (heuristic appraiser works
offline); constrained decoding keeps even a ≤4B local model safe as appraiser.

## Troubleshooting

| Symptom | Do this |
|---|---|
| `validate` fails | It names the exact field and one of five exit states, fix the field; never ship on FAIL_*. |
| Persona "feels different" than declared | `personaxis state drift`, see which coordinate consumed its deviation (u), then `/replay` to watch how it got there. |
| A trait number changes nothing | `personaxis jacobian`, σ = 0 means decorative; add per-band `expression` prose. |
| `state.json` corrupted / suspicious | `personaxis state rebuild` (detects drift from the log; `--write` repairs). Chain verify failures name the first bad entry. |
| Compiled doc stale after edits | `/compile` in the REPL, or `personaxis compile` (folds the applied self-edit overlay). |
| Conformance doubts on your build | `personaxis-evals`, 15 deterministic scenarios (C0/C1/C2) against the real engine, no API key. |
