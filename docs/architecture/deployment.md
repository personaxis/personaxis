# How a persona runs: loaded by an agent, or embedded in an app

A persona is a set of files. There are two ways to put it to work, and the same engine serves both:

- An agent loads it. Claude Code, Codex, Cursor, OpenClaw or Hermes reads the compiled persona and
  works the way it describes, on the host's model.
- An app embeds it. Your backend uses the persona through the SDK or over HTTP.

In both cases the engine that checks the persona, applies its limits, records what it learns and
recompiles its document runs on your configured model (a local model, your API key or your endpoint;
see [configuration](../guides/configuration.md)), never on the host's. The engine uses only Node's
built-in modules, so one codebase runs on Windows, Linux and macOS. OS-level isolation (macOS Seatbelt,
Linux bubblewrap) is a best-effort layer with a policy-gate fallback; see [sandbox](./sandbox.md).

## An agent loads the persona

You work with a coding agent; personaxis runs on your machine and keeps the persona the agent reads
up to date. Secrets live in your global config, which is gitignored.

Loading, in the order most people want it:

1. Compile. `personaxis compile --platform <host>` writes the persona where the host reads it
   (`PERSONA.md` with an `@PERSONA.md` reference in `CLAUDE.md` or `AGENTS.md`, or `SOUL.md`); see
   [agent-adoption](./agent-adoption.md). `personaxis onboard --host <host>` does this and the next
   step in one command.
2. Learn each turn. `personaxis hooks install --host <claude-code|codex|openclaw|hermes>` wires the
   host's end-of-turn hook (Claude Code and Codex `Stop`, Hermes `agent:end`, OpenClaw `command:stop`)
   to pipe the turn to `personaxis observe --stdin`. That runs one governed tick on your model and
   recompiles the document when the tick leaves it stale. No host tokens are spent, because the host
   cannot see inside this process and the hook is what feeds it.
3. On demand through MCP. The `personaxis-mcp` server exposes tools (`persona_observe`,
   `persona_state`, `persona_propose_edit` and the rest, listed in [mcp](../commands/mcp.md#as-a-server))
   that the agent calls only when it decides to.
4. From an editor through ACP. `personaxis-acp` is the process an editor that speaks the Agent Client
   Protocol (Zed, JetBrains, VS Code) launches to run a persona; the turn runs with the persona's gate
   and record attached.
5. Optionally, `personaxis watch` recompiles when you hand-edit the spec and checks periodically for a
   stale document. Hooks do the per-turn learning; `watch` handles idle and manual edits.

Per-host steps are in [integrations](../integrations/README.md).

## An app embeds the persona

A deployed application uses a persona as part of its product, and it learns from the end user's
conversation with the app. Secrets come from the deploy's secret manager and are resolved the same
way as in development (an environment variable), just from a different source.

- Embed the SDK: `import { Persona } from "@personaxis/sdk"` in a Node or TypeScript backend, then call
  `persona.observe(...)`, `persona.state()` and `persona.compiledIdentity()` per interaction.
- Run it as a service: `personaxis serve` exposes the persona over HTTP (`/persona/observe`,
  `/persona/state`, `/agents.md`) so an app in any language can drive it. Or run `personaxis watch` as
  a long-lived process or container that keeps `PERSONA.md` current for an app that reads the file.

The deployment shape decides which fits:

- A machine that can hold a long-lived process (a VM, a container on Railway, Fly or Render, a
  server): run `watch` or `serve`, or embed the SDK in your long-running backend.
- Serverless (for example Vercel) has no persistent process, so do not run a daemon. Trigger learning
  on demand: call the SDK or `observe` from an API route per request, or run `personaxis watch --once`
  from a scheduled function (Vercel Cron). `watch --once` does a single reconcile pass and exits.

## The surfaces

| Surface | What it is | Use it for |
|---|---|---|
| `@personaxis/core` and `@personaxis/sdk` | The engine as a library | Embedding in a Node or TypeScript backend |
| `personaxis serve` | REST plus `agents.md` over the engine | Driving a persona from any language or process |
| `personaxis-mcp` | The persona as MCP tools over stdio | MCP hosts (Claude Code, Codex, Cursor), on demand |
| `personaxis-acp` | The persona as an ACP agent over stdio | Editors that speak the Agent Client Protocol |
| `personaxis watch` | A daemon that keeps `PERSONA.md` current | An idle machine, or a long-lived process |

## Which one

- Coding with an agent and you want it to work the way a persona describes: `personaxis onboard`,
  then optionally `personaxis-mcp`. Configure a model once.
- Building an app with a persona, on a Node or TypeScript backend: the SDK.
- The same, in another language or behind an HTTP boundary: `personaxis serve`.
