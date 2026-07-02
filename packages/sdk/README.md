# @personaxis/sdk

Embed a living, governed persona in a Node/TypeScript backend.

This is the **embed SDK**: it runs the personaxis engine **in your process** (Modo 2 self-host), so
your app owns the model, the state, and the data. It is a thin, typed wrapper over
[`@personaxis/core`](../core) — the engine already does the governance (clamp + audit + injection
scan + hash-chained memory + the governance gate); this package gives your app a small, obvious API.

## Where this fits (the SDK strategy)

Like Anthropic/OpenAI, personaxis has **two kinds of SDK**, one per deployment mode:

| SDK kind | What it does | Package | Status |
|---|---|---|---|
| **Embed SDK** | Runs the engine **in-process** (your backend, your model) | `@personaxis/sdk` (this) — TS, in the monorepo | **Shipping** |
| **API-client SDK** | Calls the **managed SaaS** HTTP API (like `anthropic`/`openai` clients) | separate repos, one per language (`personaxis-python`, …) | With the SaaS (future) |

The TS embed SDK lives in this monorepo because the whole toolchain is TS and it depends directly on
`@personaxis/core`. Per-language **API-client** SDKs are separate repos (the professional pattern:
`anthropic-sdk-typescript`, `anthropic-sdk-python`, … are each their own repo) and wrap the SaaS
HTTP surface — they arrive with the managed SaaS.

## Install

```bash
npm add @personaxis/sdk   # (or pnpm/yarn) — depends on @personaxis/core
```

## Use

```ts
import { Persona } from "@personaxis/sdk";

const persona = new Persona("./.personaxis/personas/support/personaxis.md");

// 1) Load the identity as system-prompt slot #1 for YOUR LLM call.
const systemPrompt = persona.compiledIdentity();

// 2) Learn from an interaction on your configured model (env > project > global config).
await persona.observe("the customer is frustrated about a double charge", "user");

// 3) Read / nudge the runtime dials (clamped + audited).
const { values } = persona.state();
persona.adjust("mood.tone", -0.1, "customer frustrated");

// 4) Verify integrity (hash-chained memory, anomaly detection).
const audit = persona.audit();
```

## API

- `new Persona(personaPath)` — bind to a `personaxis.md` (its `state.json` + memory live alongside).
- `compiledIdentity(): string` — the compiled `PERSONA.md` (falls back to the spec body).
- `state(): { values, recentMutations }` — current envelope dials + recent audited mutations.
- `observe(observation, source?): Promise<{ report, events, recompilePending }>` — one governed
  Living-Loop tick on the resolved model (heuristic fallback offline).
- `adjust(field, delta, reason)` — a single clamped, audited mutation.
- `audit(): { mutationCount, memoryEntries, memoryChainIntact, anomalies }`.
- `reload()` — re-read the spec after an external recompile/decompile.

## Config & secrets

The model/key resolve through the same layered config the CLI uses (`resolveModel`: env > project >
global; the key from the env var named by `apiKeyEnv`). In production the key comes from your deploy's
secret manager — never a file. See the CLI's [configuration guide](../../docs/configuration.md) and
[deployment modes](../../docs/architecture/deployment.md).
