# HTTP integration, `personaxis serve` for non-MCP agents

Not every agent speaks MCP. `personaxis serve` exposes a living, governed persona over plain HTTP,
plus a self-describing `agents.md` contract (the Hugging Face "Spaces as Agent Tools" pattern): any
agent in any language can `curl /agents.md`, learn the endpoints, and drive the persona. It is the
same governed engine as the REPL and the MCP server, every mutation is clamped and audited, every
observation is prompt-injection scanned.

This is a Mode 2 surface (persona runtime powering a product), see
[../architecture/deployment.md](../architecture/deployment.md). Prefer embedding
[`@personaxis/sdk`](../architecture/deployment.md) when your backend is Node/TS; use `serve` when you
want a language-agnostic HTTP boundary or an out-of-process persona.

## Start the server

```bash
personaxis serve --persona <path-to-personaxis.md-or-PERSONA.md> [--port 7637]
```

Default port is `7637`. `serve` resolves the persona's model through the normal
[configuration](../guides/configuration.md) precedence (`config.json` `local.endpoint`/`model` or
`PERSONAXIS_ENDPOINT` + `PERSONAXIS_MODEL`), **not** just env vars. When no model resolves,
`/persona/observe` falls back to the deterministic heuristic appraiser; `/persona/agent` requires a
configured tool-calling model and returns `400` without one.

## Endpoints

Source: `packages/cli/src/commands/serve.ts`.

### `GET /agents.md`
Returns a human/agent-readable Markdown contract describing the persona and every endpoint below.
Content type `text/markdown`. Fetch this first to discover the surface.

### `GET /persona/state`
Current runtime state.

```json
{
  "values": { "mood.tone": 0.05, "affect.valence": 0.1, "...": 0.0 },
  "recent_mutations": [
    { "field": "mood.tone", "from": 0.15, "to": 0.05, "reason": "...", "clamped": false }
  ]
}
```

`recent_mutations` is the last 5 entries of the audited mutation log.

### `GET /persona/audit`
Integrity view.

```json
{
  "mutation_log": [ /* last 10 mutations */ ],
  "memory_entries": 42,
  "memory_chain_intact": true,
  "anomalies": []
}
```

`memory_chain_intact` is the result of verifying the hash-chained episodic memory;
`anomalies` lists detected issues (contradictions, untrusted-write spikes).

### `POST /persona/observe`
Run one governed Living-Loop cycle on an observation.

Request:
```json
{ "observation": "the client prefers strict TypeScript", "source": "user" }
```
`source` is one of `user | tool | internal | synthesis` (defaults to `user`) and drives the trust /
sensitive-action gates. `observation` must be a non-empty string (`400` otherwise).

Response:
```json
{
  "report": { "mutationsApplied": 0, "memoriesWritten": 1, "abstained": false },
  "events": [
    { "type": "observe" }, { "type": "appraise" }, { "type": "memory" }, { "type": "tick-complete" }
  ]
}
```

### `POST /persona/adjust`
Apply one clamped, audited mutation to an envelope field.

Request:
```json
{ "field": "mood.tone", "delta": -0.1, "reason": "user expressed frustration" }
```
`field` must be a known envelope field, otherwise `400` with the list of valid `fields`. `delta`
must be a finite number. The delta is clamped to the field's declared envelope.

Response:
```json
{ "field": "mood.tone", "from": 0.05, "to": -0.05, "clamped": false, "blocked": false, "audit": { "...": "..." } }
```

### `POST /persona/agent`
Run the persona's governed Agent Loop on a task: it proposes shell/file tool calls, each gated by the
persona's sandbox policy, executes the allowed ones, and returns the step events + how the turn ended.

Request:
```json
{ "task": "summarize the open TODOs in this repo" }
```

Response:
```json
{
  "outcome": {
    "turn": "6fb83c6a-5bee-489a-a5c6-7e502405c6d7",
    "stopReason": "answered",
    "answer": "…",
    "steps": 3,
    "cost": { "tokens": 1380, "usd": 0.004 }
  },
  "events": [ /* step events */ ],
  "trace": [ /* trace file paths, if enabled */ ]
}
```

`stopReason` is a closed set, so a client can switch on it: `answered` (the loop said it was done),
`budget` (a step, token, cost or time ceiling), `stopped` (a stop condition the spec declared),
`refused` (a guard would not let it continue), `interrupted`, `empty`, `failed`, `abandoned`. Every
one but the first three closes with an empty `answer` or an explanatory `failure: { code, message }`.

`turn` is the entry id in the persona's record, so the same turn can be looked up in `record.jsonl`
afterwards: what was asked, what was answered, how it ended and what it cost.

The specific ceiling that stopped a run, the verification verdict with each verifier named, and the
wall clock are all in `events` (`agent-stop-condition`, `verify-result` / `verify-complete`,
`agent-budget`), not in `outcome`, which carries only what any loop can report.

Requires a configured tool-calling model (`400` without one). This is non-interactive: anything the
sandbox policy marks as needing approval is **denied** (never auto-approved over HTTP). `task` must be
a non-empty string.

## Notes

- Request bodies are capped at 1 MB; oversized requests are refused.
- Invalid JSON bodies return `400 { "error": "invalid JSON body" }`; unknown routes return `404`;
  unexpected errors return `500` with the message.
- Untrusted observations are injection-scanned; malicious content does not steer evolution.
- Identity is immutable over HTTP, only runtime state + memory evolve, within the universal invariants.

## When to use this vs. the alternatives

| You want… | Use |
|---|---|
| A persona embedded in a Node/TS backend | `@personaxis/sdk` (`import { Persona }`) |
| A language-agnostic HTTP boundary / out-of-process persona | **`personaxis serve`** (this doc) |
| On-demand persona tools inside an MCP host (Claude Code/Codex/Cursor) | `personaxis-mcp` ([claude-code.md](./claude-code.md)) |
| A fully managed, we-host-it offering | The SaaS design ([../architecture/saas-managed.md](../architecture/saas-managed.md)) |
