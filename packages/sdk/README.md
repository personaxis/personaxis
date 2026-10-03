# @personaxis/sdk

Run a governed [personaxis.md](https://github.com/personaxis/persona.md) persona inside your own
Node or TypeScript backend. The engine runs in your process: your app owns the model, the state
and the data. This package is the small, typed API over
[`@personaxis/core`](https://www.npmjs.com/package/@personaxis/core), which does the governance
(clamp, audit, injection scan, hash-chained record, the gate on every tool call).

```bash
npm i @personaxis/sdk
```

## Use

```ts
import { Persona } from "@personaxis/sdk";

const persona = new Persona("./.personaxis/personas/support/personaxis.md");

// 1. The compiled identity, as the system prompt of YOUR model call.
const systemPrompt = persona.compiledIdentity();

// 2. One governed tick of the living loop on an observation, on the configured model.
await persona.observe("the customer is frustrated about a double charge", "user");

// 3. Read the state, or move one value (clamped to its envelope and recorded).
const { values } = persona.state();
await persona.adjust("mood.tone", -0.1, "customer frustrated");

// 4. Let the persona do a task with its own tools, under its policy.
const run = await persona.agentRun("Draft a reply to the open ticket", { maxSteps: 8 });
if ("error" in run) throw new Error(run.error);   // no model configured
console.log(run.outcome);

// 5. Check the record.
const audit = persona.audit();   // { mutationCount, memoryEntries, memoryChainIntact, anomalies, … }
```

## API

**`new Persona(path)`** binds to a `personaxis.md`; its `state.json` and record live beside it.

| Method | Returns |
|---|---|
| `compiledIdentity()` | the compiled `PERSONA.md`, or the spec body if it has not been compiled |
| `state()` | `{ values, recentMutations }` |
| `envelopes()` | the mutable fields with their ranges, and the hard-enforced virtues |
| `observe(text, source?)` | `Promise<{ report, events, recompilePending }>` |
| `adjust(field, delta, reason, { by? })` | `Promise` of the recorded move; `by: "person"` for a human edit |
| `agentRun(task, { maxSteps?, onApproval?, asker? })` | `Promise<{ outcome, events, trace }>`, or `{ error }` when no model is configured |
| `audit()` | `{ mutationCount, memoryEntries, memoryChainIntact, memoryChainBrokenAt, anomalies }` |
| `forget(hash, reason)` | tombstones a memory entry; the chain stays verifiable |
| `proposeEdit(path, value, rationale)`, `listProposals()`, `decideEdit(id, decision, approver)` | governed edits to the spec itself |
| `recompileStatus()` | whether `PERSONA.md` is stale after a self-edit |
| `reload()` | re-read the spec after an external edit |

Functions that need no persona: `scanText(text)`, `guardInput(text, { blockAt? })` (decide whether an
incoming message may reach your agent), `scanConfig(content, filename?)`, `skillReview(path)`,
`evaluateCmd(command, sandbox, approval, personaPath?)`, and `resolveModel()`.

## Model and keys

The model resolves through the same layered config the CLI uses: environment, then project, then
global. The key comes from the environment variable the config names in `apiKeyEnv`, so in
production it comes from your secret manager and never from a file. See the
[configuration guide](https://github.com/personaxis/personaxis/blob/main/docs/guides/configuration.md).

MIT licensed.
