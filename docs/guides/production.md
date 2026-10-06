# Running personas in production

Three integration surfaces, one engine. Deep dives:
[`architecture/deployment.md`](../architecture/deployment.md) (the ways to run a persona),
[`integrations/`](../integrations/README.md) (per-host wiring),
[`configuration.md`](./configuration.md) (models/keys).

## Choose a surface

| Surface | When | How |
|---|---|---|
| MCP (`personaxis-mcp`) | Your agent host speaks MCP (Claude Code, Codex, Cursor) | stdio server, 16 tools (`persona_compiled`, `persona_observe`, `adjust_persona_state`, …; the list is in [mcp](../commands/mcp.md#as-a-server)). Confine paths with `--root`; `persona_decide_edit` needs the explicit `--allow-decide` flag (the proposer is not the approver). |
| SDK (`@personaxis/sdk`) | You own the backend | The `Persona` class is the whole engine façade (`observe` / `adjust` / `agentRun` / `audit` / `proposeEdit` / …). MCP and serve are thin hosts over it, so embedding it gives you the same governance. |
| HTTP (`personaxis serve`) | Non-MCP agents / services | HTTP + `agents.md` low-context interop; run it next to the persona files. |

Compiled placement for coding agents: `personaxis compile --platform claude-code`
(`.claude/agents/<slug>.md`), `--platform codex`, `--platform openclaw` or `--platform hermes`. The persona ships with the repo.

## The four production controls

1. Lock the posture: `personaxis improve locked`, state still adapts inside
   envelopes; the spec cannot self-modify. `suggesting` queues proposals for human
   `personaxis review`. A sibling `policy.yaml` can only make things stricter.
2. Gate deploys in CI:
   ```bash
   personaxis validate <spec>    # exit 0 only on PASS/PASS_WITH_WARNINGS
   personaxis state drift        # exit 2 once any layer exceeds its declared threshold
   ```
3. Audit trail: `mutation_log` and episodic memory are hash-chained;
   `personaxis state rebuild` proves state ≡ fold(log) and repairs a torn
   `state.json`; `/audit` in the REPL summarizes chain health. Right-to-erasure is a
   tombstone, the chain still verifies after real deletion.
4. Keys and config: BYOK via env (`PERSONAXIS_ENDPOINT` / `PERSONAXIS_MODEL` /
   key env-vars) or `personaxis config` (global/project/per-persona precedence).
   Never commit API keys; config files reference key env names, not values.

## Sizing and overhead

The governed tick is local math: p99 0.074 ms at 8 coordinates, 0.094 ms at 16 and 0.245 ms at 64
(see [GUARANTEES](../GUARANTEES.md)). The LLM appraiser is the only network hop and is optional
(the heuristic appraiser works offline); constrained decoding keeps even a small local model safe as
appraiser.

## Keep your own agent, add the persona

Keep your existing agent (any framework, any model) and add personaxis around it. Three tools:

- Screen the input. Before an untrusted message reaches your agent, check it for prompt injection or
  jailbreak. CLI: `personaxis scan <file>` (exit 0 clean, 2 risky, 3 malicious; `--strict` also fails on
  suspicious with exit 1, a CI gate). SDK: `guardInput(text)` returns `{ allowed, verdict, reason, scan }`,
  so an adversarial input cannot steer the agent out of its persona.
- Sign the persona. `personaxis sign` writes `personaxis.sig.json`: the SHA-256 of the source
  `personaxis.md`, a deterministic sigil fingerprint, the `canonical_id` and the `spec_version`.
- Verify it. `personaxis verify` recomputes the hash and reports whether the file changed (exit 0
  verified, 1 mismatch, 2 error), gateable in CI so a changed persona never ships silently. The record
  carries no cryptographic key, so it shows that the file changed, not who changed it.

## Troubleshooting

| Symptom | Do this |
|---|---|
| `validate` fails | It names the exact field and one of five exit states, fix the field; never ship on FAIL_*. |
| Persona behaves differently than declared | `personaxis state drift` shows which coordinate consumed its deviation (u); `personaxis audit --tab Integrity` replays how it got there. |
| A trait number changes nothing | `personaxis jacobian`: σ = 0 means decorative; add per-band `expression` prose. |
| `state.json` corrupted / suspicious | `personaxis state rebuild` (compares it with the log; `--write` repairs). Chain verify failures name the first bad entry. |
| Compiled doc stale after edits | `/compile` in the REPL, or `personaxis compile` (folds the applied self-edit overlay). |
| Conformance doubts on your build | `personaxis-evals`, 19 deterministic scenarios (C0/C1/C2) against the real engine, no API key. |
