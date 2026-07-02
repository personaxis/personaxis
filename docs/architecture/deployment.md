# Deployment & usage modes — how personaxis actually runs

The single most common confusion: *"is personaxis a dev tool, or something I deploy for my app?"*
It is **both** — the same engine, used in two different modes. This doc names them and shows how the
persona stays alive in each, on which model, and cross-OS.

## The engine vs the consumer

Every deployment is a combination of two planes:

- **The living engine** — evaluate `personaxis.md` → govern/evolve → compile `PERSONA.md` → memory.
  It runs on **your configured model** (local / your API key / your endpoint — see
  [configuration.md](../configuration.md)), never the host's.
- **The consumer** — whatever reads the persona: a coding agent (Claude Code/Codex), a deployed app,
  or the `personaxis` REPL. It reads `PERSONA.md` (via `@PERSONA.md`) and may call tools on-demand.

The engine is **Node-pure** (`@personaxis/core` uses only `node:fs`/`node:crypto`), so one codebase
runs on Windows, Linux, and macOS. OS-specific sandboxing (macOS Seatbelt / Linux bubblewrap) is a
best-effort layer with a policy-gate fallback (see [sandbox.md](./sandbox.md)).

## Two use-modes

### Modo 1 — Dev companion (augment a coding agent, locally)
You code with Claude Code/Codex; personaxis runs **on your machine** and keeps `PERSONA.md` fresh so
the coding agent adopts a living persona. It learns from *you ↔ the coding agent*. There is no
"production" here — it's a developer tool. Secrets live in your **global config** (gitignored).

How the persona learns each turn (it can't see inside the host's process):

1. **Host hook (primary).** `personaxis hooks install --host <claude-code|codex|openclaw|hermes>` wires
   that host's end-of-turn hook (Claude Code / Codex `Stop`, Hermes `on_session_end`, openclaw
   `command:stop`) to pipe the turn to `personaxis observe --stdin`. That runs **one governed tick on
   your model** and recompiles the identity (`PERSONA.md`/`SOUL.md`) on drift — **no host tokens spent**.
2. **MCP on-demand.** The `personaxis-mcp` server exposes tools (`persona_observe`, `persona_state`,
   `persona_propose_edit`, …) the agent calls **only when it decides to** — not every message.
3. **`personaxis watch` (optional).** A local daemon that recompiles when you hand-edit the spec and
   runs a drift heartbeat. Hooks do the per-turn learning; watch handles idle/manual edits.

Wire the identity in once: `personaxis compile` injects `@PERSONA.md` into `CLAUDE.md`/`AGENTS.md`.
See [../setup or integrations](../integrations/) for per-host steps.

### Modo 2 — Persona runtime in an app (a live persona powering a product feature)
A deployed application uses a persona as part of its product (e.g. a support character with a
consistent, evolving personality). It learns from *end-user ↔ app*. Secrets come from the deploy's
secret manager (never committed) — same resolution logic as dev (env var), just a different source.

Two ways to run the engine in Modo 2:

- **Embed the SDK** — `import { Persona } from "@personaxis/sdk"` in your Node/TS backend and call
  `persona.observe(...)` / `persona.state()` / `persona.compiledIdentity()` per interaction. Best when
  your backend is Node/TS.
- **Run it as a service** — `personaxis serve` exposes the persona over HTTP (`/persona/observe`,
  `/persona/state`, `/agents.md`) so an app in **any** language/process can drive it. Or run
  `personaxis watch` as a long-lived process/container that keeps `PERSONA.md` fresh for a
  file-reading app.

**Deployment shape matters:**
- A machine that can hold a **long-lived process** (a VM, a container on Railway/Fly/Render, a
  server) → run `watch`/`serve`, or embed the SDK in your long-running backend.
- **Serverless (e.g. Vercel)** has no persistent process → don't run a daemon. Trigger learning
  **on-demand**: call the SDK/`observe` from an API route per request, or run `personaxis observe
  --once` from a scheduled function (Vercel Cron). `--once` is designed for exactly this.

## The four surfaces (pick by how the consumer talks)

| Surface | What | Use it for |
|---|---|---|
| **`@personaxis/core` / `@personaxis/sdk`** | The engine as a library | Modo 2, embed in a Node/TS backend |
| **HTTP `personaxis serve`** | REST + `agents.md` over the engine | Modo 2, drive from any language/process |
| **MCP `personaxis-mcp`** | Persona as MCP tools (stdio) | Modo 1, MCP hosts (Claude Code/Codex/Cursor), on-demand |
| **Daemon `personaxis watch`** | Keeps `PERSONA.md` fresh in the background (uses the library) | Modo 1 idle / Modo 2 long-lived process |

## The managed SaaS (D) — future, not built here

The managed offering: **we** host the engine and provide **our** model (billed via our key), with
per-tenant isolation, so a client points at our API and we keep their `PERSONA.md` alive without
running any infrastructure themselves. It does **not** require always-on VMs — it's all Node/TS with a
**serverless API + a durable queue + stateless workers + Postgres** (pay per work, scale horizontally).
Its design lives in [saas-managed.md](./saas-managed.md); it is **not implemented in this repo**.

## Which do I pick?

- Coding with Claude Code and want a living persona → **Modo 1**: `personaxis hooks install` + (optional)
  `personaxis-mcp`. Configure a model once ([configuration.md](../configuration.md)).
- Building an app that needs an evolving persona and your backend is Node/TS → **Modo 2, SDK**.
- Same, but a different language / you want an HTTP boundary → **Modo 2, `serve`**.
- You want zero infra and to pay for a managed persona → **the SaaS (D)** (when available).
