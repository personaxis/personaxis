# Integrations: load a persona into your coding agent

Have Claude Code, Codex, OpenClaw or Hermes load a persona and work the way it describes. Learning from
each turn runs on your own model and spends no host tokens.

## How it works

There are four ways to load a persona, and you can use more than one:

| Way | What the agent gets | Where it is described |
|---|---|---|
| Compile into the host's file | the persona's compiled document, read at the start of every turn | below, and [agent-adoption](../architecture/agent-adoption.md) |
| A per-turn hook | the persona learns from each turn, on your model, and the document is recompiled when it changes | below |
| MCP tools (`personaxis-mcp`) | tools it can call when it decides to: read and adjust the persona, scan text, propose a governed edit | [claude-code.md](./claude-code.md), [mcp](../commands/mcp.md#as-a-server) |
| ACP (`personaxis-acp`) | the persona as the agent in an editor that speaks the Agent Client Protocol | [acp.md](./acp.md) |

The host reads a compiled persona file at the start of every turn:

- Claude Code reads `CLAUDE.md`, which references `@PERSONA.md`.
- Codex reads `AGENTS.md`, which references `@PERSONA.md`.
- OpenClaw reads `SOUL.md`.
- Hermes reads `~/.hermes/SOUL.md`.

personaxis runs independently on your machine, on your model. It watches the conversation through a host
hook, runs one governed tick per turn (`observe`), and recompiles the persona file when the persona
changes. You do not need MCP for this; MCP is for on-demand tools. The loop is: host hook, then
`personaxis observe` on your model, then the persona file refreshed, then the host reads it.

## Install personaxis

personaxis is an npm package with a `personaxis` binary. Install it once, globally:

```bash
npm install -g personaxis      # provides the `personaxis` command on your PATH
```

Everything below uses the `personaxis` command, with no repo checkout and no hardcoded paths. The host
hooks run `personaxis observe`, the binary on your PATH, so it works on any machine that installed the
package.

## One-command onboarding

After the model step below, this wires everything (compile, the `@` reference or `SOUL.md`, and the hook):

```bash
personaxis onboard --host claude-code      # or: codex | openclaw | hermes   (add --global to wire it for all projects)
```

It checks your model, compiles the persona, installs the end-of-turn hook and prints the one manual step
(put your API key in the environment variable). It is re-runnable and idempotent.

## The same steps, one at a time

### 1. Point personaxis at your model, once, globally

```bash
personaxis config set --global local.endpoint https://api.your-provider.com/v1
personaxis config set --global local.model    your-model
personaxis config set --global local.apiKeyEnv YOUR_API_KEY_ENV_VAR
```

The key is never written to a file: `apiKeyEnv` names the environment variable that holds it. Put the key
in your environment (a gitignored `.env`, your shell profile, or the deploy's secret manager):

```powershell
# PowerShell (this shell / session)
$env:YOUR_API_KEY_ENV_VAR = "<your-key>"
```

The hook runs as a child of your coding agent, so the agent's process must have the variable set. Set it
before launching the agent (or add it to your shell profile), otherwise `observe` refuses for lack
of a model and nothing is learned.

### 2. Compile the persona and wire the reference

```bash
personaxis compile --root                 # writes PERSONA.md and injects @PERSONA.md into CLAUDE.md/AGENTS.md
# OpenClaw and Hermes read SOUL.md instead:
personaxis compile --root --platform openclaw   # → SOUL.md
personaxis compile --root --platform hermes      # → .hermes/SOUL.md
```

### 3. Install the per-turn hook

```bash
personaxis hooks install --host claude-code            # this project (.claude/settings.json)
personaxis hooks install --host claude-code --global   # all projects (~/.claude/settings.json)
```

Now every turn feeds one governed tick to your model and the persona file is refreshed when the persona
changes, with no host tokens spent. The hook command is `personaxis observe --stdin`, the binary on your
PATH. With many projects, use `--global`: one hook in `~/.claude/settings.json` covers every project. The
hook's `observe` resolves the current project's `.personaxis/personaxis.md`, and a project without a
persona is a silent no-op, so each project's persona evolves only while you work in it.

### Verify it works

```bash
personaxis observe --observation "the user prefers terse, spec-cited answers" --source user --json
# → { "ok": true, "report": { ... } }   (uses your configured model)
```

If `ok` is true and your model is reachable, the wiring is correct.

## Which host

| Host | Persona file | Hook event | Guide |
|---|---|---|---|
| Claude Code | `CLAUDE.md` → `@PERSONA.md` | `Stop` | [claude-code.md](./claude-code.md) |
| Codex | `AGENTS.md` → `@PERSONA.md` | `Stop` | [codex.md](./codex.md) |
| OpenClaw | `SOUL.md` (workspace root) | `command:stop` | [openclaw.md](./openclaw.md) |
| Hermes | `~/.hermes/SOUL.md` | `agent:end` | [hermes.md](./hermes.md) |
| An editor that speaks ACP | launched as `personaxis-acp` | none | [acp.md](./acp.md) |
| Any other agent or app | HTTP | n/a | [http-agents.md](./http-agents.md) |

## Other ways to use it

- On-demand persona tools: let the agent read or adjust the persona, run security scans, or propose a
  governed self-edit when it decides to. See [claude-code.md](./claude-code.md) §2.
- A persona inside your own app: embed [`@personaxis/sdk`](../../packages/sdk) or run
  [`personaxis serve`](../commands/serve.md); see [deployment](../architecture/deployment.md).

## What the hook learns

Each turn, personaxis appraises the last message on your model and, governed by the persona's
`improvement_policy.mode`:

- `locked`: observes and remembers, but never self-edits.
- `suggesting`: queues proposed self-edits for you to review; the persona file is not changed on its own.
- `autonomous`: auto-applies (still gated by consensus and protected invariants) and recompiles the
  persona file.

Change it with `personaxis improve <mode>`. The limits the author declared can never be self-edited in
any mode. See [self-evolution](../architecture/self-evolution.md). The hook sees the person's last
message (up to 1200 characters) and not the whole turn; [runtime](../architecture/runtime.md) lists what
it captures.

## More

- [configuration](../guides/configuration.md): model and key resolution (environment, project, global, per-persona).
- [deployment](../architecture/deployment.md): the ways to run a persona.
- [hooks](../commands/hooks.md), [observe](../commands/observe.md) and [watch](../commands/watch.md).
