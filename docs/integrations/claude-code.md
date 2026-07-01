# Claude Code integration — the complete guide

Claude Code brings the powerful model and the tool-use loop. personaxis brings the **living,
governed identity**: a fresh `PERSONA.md`, per-turn learning on *your* model, memory, and
on-demand persona tools. There are three ways to wire the two together — you can use one or all.

> This is the English, hooks-aware superset of the Spanish
> [claude-code-mcp.md](./claude-code-mcp.md) (MCP-only walkthrough with a real session trace).

| Path | What Claude Code gets | Token cost to the host |
|---|---|---|
| **1. Always-fresh baseline** (`compile` + `hooks install`) | `@PERSONA.md` in `CLAUDE.md`, kept alive by a per-turn tick | **Zero** — the tick runs on *your* configured model |
| **2. On-demand tools** (`personaxis-mcp`) | Persona tools (state, observe, audit, self-edit, security scans) it can call | Only the tokens of the calls the agent chooses to make |
| **3. Native subagent** (`compile --platform claude-code`) | A `.claude/agents/<slug>.md` subagent that *is* the persona | Normal subagent cost |

---

## 1. Always-fresh baseline (recommended)

This is Modo 1 (dev companion) from [deployment.md](../architecture/deployment.md): personaxis runs
locally and keeps `PERSONA.md` current so Claude Code adopts a living persona every session.

### Wire the identity in once

```bash
personaxis compile --root
```

`compile` writes the repo-root `PERSONA.md` (the compiled, qualitative identity document) and injects
a managed baseline into `CLAUDE.md`:

```markdown
<!-- PERSONA:BASELINE:BEGIN -->
## Behavioral Baseline

Always read @PERSONA.md at project root before acting.
Apply everything defined there to every decision, regardless of role.
Read your own @PERSONA.md too if one was provided to you.
<!-- PERSONA:BASELINE:END -->
```

The `@PERSONA.md` reference makes Claude Code read the live file each session, so a recompile is
picked up automatically. Re-running `compile` replaces the managed block, never duplicates it; your
own `CLAUDE.md` content is untouched.

### Keep it alive per turn

The engine can't see inside Claude Code's process, so the host has to **feed** it. Install the
end-of-turn hook:

```bash
personaxis hooks install --host claude-code           # this project's .claude/settings.json
personaxis hooks install --host claude-code --global  # or all projects (~/.claude/settings.json)
```

This adds a `Stop` hook to `.claude/settings.json` that, at the end of every turn, runs:

```
personaxis observe --stdin --source user
```

`observe` runs **one governed Living-Loop tick on your configured model** — appraise the turn,
apply any clamped/governed state nudge, write memory, and mark `PERSONA.md` stale on drift. Because
the tick runs on *your* model (see [configuration.md](../configuration.md)), it spends **no host
tokens**. Recompile when it reports staleness (`personaxis compile --root`, or `compile --if-pending`).

Install is idempotent (it merges alongside existing hooks); `personaxis hooks uninstall` removes only
ours. Uninstall with `personaxis hooks uninstall --host claude-code`.

> **Optional daemon.** `personaxis watch` recompiles when you hand-edit the spec and runs a drift
> heartbeat. Hooks do the per-turn learning; `watch` handles idle/manual edits.

---

## 2. On-demand persona tools (MCP)

Register the stdio MCP server so Claude Code can call persona tools **when it decides to** — not on
every message. Unlike the hook, these calls run inside the host's turn and cost host tokens, but only
for the tools actually invoked.

### Register the server

`.mcp.json` in the project (published binary):

```json
{
  "mcpServers": {
    "personaxis": {
      "command": "personaxis-mcp"
    }
  }
}
```

Or, running from this repo without publishing:

```json
{
  "mcpServers": {
    "personaxis": {
      "command": "node",
      "args": ["packages/mcp/dist/index.js"]
    }
  }
}
```

CLI equivalent: `claude mcp add personaxis -- personaxis-mcp`.

### The tools it exposes

`personaxis-mcp` (`buildServer`, `packages/mcp/src/index.ts`) exposes **16 tools**. Most take a
`persona` argument — the path to the persona's `personaxis.md`/`PERSONA.md` (its `state.json` and
memory live alongside it).

| Tool | What it does |
|---|---|
| `persona_compiled` | Return the compiled identity document — load as system-prompt slot #1. |
| `persona_state` | Current runtime state: live envelope values + the 5 most recent audited mutations. |
| `persona_envelopes` | List mutable fields with their `[min,max]` envelopes + hard-enforced (never-mutable) virtues. |
| `adjust_persona_state` | Apply one signed delta to an envelope field — **clamped** to the envelope, appended to the mutation log. |
| `persona_observe` | Run one governed Living-Loop cycle (observe → appraise → evolve → memory) on an observation. |
| `persona_audit` | Mutation log + episodic-memory chain integrity + detected anomalies. |
| `persona_forget` | Honor a deletion request: tombstone a memory entry by hash (chain stays verifiable). |
| `persona_recompile_status` | Whether `PERSONA.md` is stale (a self-edit was applied since the last compile). |
| `persona_propose_edit` | Propose a governed edit to the persona's own **spec** (protected paths refused). |
| `persona_proposals` | List self-edit proposals (pending/applied/…) + the active overlay. |
| `persona_decide_edit` | Approve (apply + mint a version) or reject a pending proposal by id. |
| `skill_review` | Security-review a skill directory/`SKILL.md` before use → findings + verdict + hash. |
| `scan_text` | Scan untrusted text (tool output, fetched content) for prompt-injection before trusting it. |
| `evaluate_command` | Two-axis policy check (sandbox × approval) for a shell command → `allow \| ask \| deny`. |
| `scan_config` | Security-scan an agent config (`CLAUDE.md`, `AGENTS.md`, `.cursorrules`, …) for injection/leaks. |
| `agent_run` | Run the persona's governed Agent Loop on a task (sandbox-gated tool calls). Needs a configured model. |

Because MCP hosts can't run an LLM through the server, `persona_recompile_status` reports staleness
and the host runs `personaxis compile` to refresh. `persona_observe` and `agent_run` use the
persona's [configured model](../configuration.md).

See [claude-code-mcp.md](./claude-code-mcp.md) for a full simulated session trace (load identity →
scan external content → deny a destructive command → adjust affect → observe → audit).

---

## 3. Native subagent

To make Claude Code adopt the persona *as a subagent* (the agent **is** the persona), compile a
sub-persona into Claude Code's convention:

```bash
personaxis compile <slug> --platform claude-code
```

This writes the canonical `.personaxis/personas/<slug>/PERSONA.md` **and** exports
`.claude/agents/<slug>.md` (with `name`/`description` frontmatter) so Claude Code routes
task-specific work to it via `/agents`. Local skills declared in `extensions.skills` are
materialized to `.claude/skills/<name>/`. The `.claude/agents/<slug>.md` file is a generated export
— edit `.personaxis/personas/<slug>/personaxis.md` and recompile, or edit the export and
`personaxis push <slug>` to fold the change back.

See [../architecture/agent-adoption.md](../architecture/agent-adoption.md) for the compile-target
model, and [../architecture/deployment.md](../architecture/deployment.md) for how the three paths map
onto the two use-modes.

---

## Which path do I pick?

- **Want a living persona while you code, for free to the host?** Path 1 (`compile` + `hooks install`).
- **Want the agent to inspect/adjust the persona or run security scans mid-task?** Add Path 2 (MCP).
- **Want a dedicated, routable subagent that is the persona?** Path 3 (`--platform claude-code`).

They compose: a common setup is Path 1 for the always-fresh baseline plus Path 2 for on-demand tools.
