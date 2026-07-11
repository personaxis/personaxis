# Integrations, use personaxis with your coding agent

**Goal:** give your coding agent (Claude Code, Codex, openclaw, or Hermes) a *living, governed
persona* that stays fresh, learns from each turn on **your own model** (e.g. Cohere), and never
spends the host's tokens to do it.

## The mental model (read this first)

Two things, always:

1. **The host** (Claude Code/Codex/…) reads an **identity file** at the start of every turn:
   - Claude Code → `CLAUDE.md` (which references `@PERSONA.md`)
   - Codex → `AGENTS.md` (references `@PERSONA.md`)
   - openclaw → `SOUL.md`
   - Hermes → `~/.hermes/SOUL.md`
2. **personaxis** (running independently on your machine, on *your* model) keeps that identity file
   **fresh**: it watches the conversation via a **host hook**, runs one governed tick per turn
   (`observe`), and recompiles the identity when the persona evolves.

You do **not** need MCP for this. MCP is optional (for on-demand tools). The core loop is: *host hook
→ `personaxis observe` on your model → identity file refreshed → host reads it.*

## Install personaxis (production)

personaxis is an npm package with a `personaxis` binary, install it once, globally:

```bash
npm install -g @personaxis/persona.md      # provides the `personaxis` command on your PATH
```

Everything below uses the `personaxis` command (no repo checkout, no hardcoded paths). The host hooks
run `personaxis observe`, the binary on your PATH, so it works on any machine that installed the package.

## One-command onboarding (recommended)

After the model config step below, this wires the whole thing (compile + `@`-reference/`SOUL.md` + hook):

```bash
personaxis onboard --host claude-code      # or: codex | openclaw | hermes   (add --global to wire it for ALL projects)
```

It checks your model, compiles the identity, installs the end-of-turn hook, and prints the one manual
step (put your API key in the env var). Re-runnable and idempotent. Prefer this over the manual steps.

## Manual quickstart (what onboarding does, step by step)

### 1. Point personaxis at your model, once, globally

```bash
personaxis config set --global local.endpoint https://api.cohere.ai/compatibility/v1
personaxis config set --global local.model    command-a-03-2025
personaxis config set --global local.apiKeyEnv COHERE_API_KEY
```

The key is **never written to a file**: `apiKeyEnv` names the env var that holds it. Put the key in
your environment (a gitignored `.env`, your shell profile, or the deploy's secret manager in prod):

```powershell
# PowerShell (this shell / session)
$env:COHERE_API_KEY = "<your-cohere-key>"
```

> The hook runs as a child of your coding agent, so the agent's process must have `COHERE_API_KEY`
> set. Set it **before launching** the agent (or add it to your shell profile), else `observe` falls
> back to the offline heuristic (no real learning).

### 2. Compile the identity + wire the reference

```bash
personaxis compile --root                 # writes PERSONA.md and injects @PERSONA.md into CLAUDE.md/AGENTS.md
# openclaw / Hermes read SOUL.md instead:
personaxis compile --root --platform openclaw   # → SOUL.md
personaxis compile --root --platform hermes      # → .hermes/SOUL.md
```

### 3. Install the per-turn hook (learning on your model)

```bash
personaxis hooks install --host claude-code            # THIS project (.claude/settings.json)
personaxis hooks install --host claude-code --global   # ALL projects (~/.claude/settings.json)
```

Now every turn feeds one governed tick to your model and refreshes the identity on drift, no host
tokens. The hook command is just `personaxis observe --stdin` (the binary on your PATH, no machine paths).

> **Many projects?** Use **`--global`**: one hook in `~/.claude/settings.json` covers every project.
> The hook's `observe` resolves the **current** project's `.personaxis/personaxis.md`; a project without
> a persona is a **silent no-op** (it never breaks the host). So a global hook + a per-project persona
> = each project's persona evolves only while you work in it. Without `--global`, the hook is
> per-project (`.claude/settings.json`), which you commit or gitignore as you prefer.

### Verify it works

```bash
personaxis observe --observation "the user prefers terse, spec-cited answers" --source user --json
# → { "ok": true, "report": { ... } }   (uses your configured model)
```

If `ok` is true and your model is reachable, the wiring is correct.

## Which host? (each has its own page)

| Host | Identity file | Hook event | Guide |
|---|---|---|---|
| **Claude Code** | `CLAUDE.md` → `@PERSONA.md` | `Stop` | [claude-code.md](./claude-code.md) |
| **Codex** | `AGENTS.md` → `@PERSONA.md` | `Stop` | [codex.md](./codex.md) |
| **openclaw** | `SOUL.md` (workspace root) | `command:stop` | [openclaw.md](./openclaw.md) |
| **Hermes** | `~/.hermes/SOUL.md` | `on_session_end` | [hermes.md](./hermes.md) |
| Any (no MCP/agent) | HTTP |, | [http-agents.md](./http-agents.md) |

## Use cases

- **Living dev companion (most common).** Your Claude Code/Codex learns your project's conventions and
  keeps a consistent persona across sessions, automatically, on your cheap/local model. → Quickstart above.
- **On-demand persona tools.** Let the agent read/adjust the persona, run security scans, or propose a
  governed self-edit *when it decides to*. → MCP server: [claude-code.md](./claude-code.md) §2.
- **A persona inside your own app** (not a coding agent). → embed [`@personaxis/sdk`](../../packages/sdk)
  or run [`personaxis serve`](../commands/serve.md); see [deployment.md](../architecture/deployment.md).

## What "learning" looks like (and safety)

Each turn, personaxis appraises the conversation on your model and, **governed by the persona's
`improvement_policy.mode`**:

- `locked` → observes + remembers, but never self-edits.
- `suggesting` (safe default) → **queues** proposed self-edits (review them; the identity file is NOT
  auto-changed), no surprise drift.
- `autonomous` → auto-applies (still gated by consensus + protected invariants) and recompiles the
  identity file.

Change it with `personaxis improve <mode>`. Protected identity/safety invariants can **never** be
self-edited in any mode. See [architecture/self-evolution.md](../architecture/self-evolution.md).

## More

- [configuration.md](../guides/configuration.md), model/key resolution (env > project > global, per-persona).
- [architecture/deployment.md](../architecture/deployment.md), the two use-modes and four surfaces.
- [commands/hooks.md](../commands/hooks.md) · [commands/observe.md](../commands/observe.md) · [commands/watch.md](../commands/watch.md).
