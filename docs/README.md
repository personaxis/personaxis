# personaxis CLI — documentation

Feature-organized reference for **what is implemented** in this repo (the reference CLI
for the personaxis.md spec). It exists so a human — or another AI working on the project —
can see at a glance how each piece works and verify the implementation matches the design.

The spec itself (normative field reference) lives in the sibling `persona.md` repo:
[docs/SPEC.md](../../persona.md/docs/SPEC.md) and
[docs/PERSONA_PROMPTING.md](../../persona.md/docs/PERSONA_PROMPTING.md).

**New here? Start with [CONCEPTS_FAQ.md](CONCEPTS_FAQ.md)** — a single, navigable answer to the
common conceptual questions (compile/decompile, sub-personas, what self-evolves and who decides,
the modes, the six memory kinds, sessions, the sandbox, every REPL command), each linking to the
deeper architecture doc below.

## Map

```
docs/
  CONCEPTS_FAQ.md      START HERE — direct answers to the common conceptual questions
  configuration.md     model/endpoint/API-key config (global+project+per-persona, dev & prod)
  providers.md         the local | byok | agent | remote providers for compile/decompile
  architecture/        how the system works, end to end
    deployment.md        the two use-modes, the four surfaces, hooks, cross-OS, self-host vs SaaS
    self-evolution.md    how personaxis.md self-edits (whole spec), and how it compiles to PERSONA.md (the "living" loop)
    compile.md           compile / decompile, the artifact model, canonical output paths, purely-qualitative compiled doc
    multi-persona.md     root + sub-personas, @routing, isolation, per-persona colors
    agent-adoption.md    how Claude Code / Codex adopt a personaxis persona
    saas-managed.md      DESIGN (not built here) — the managed SaaS: serverless API + queue + workers + Postgres
    memory.md            the six memory.types (episodic, semantic, procedural, autobiographical, user_preferences, evaluations)
    sessions.md          persistent per-persona conversations, /sessions, /resume, /compact (persisted)
    awareness.md         runtime structural self-knowledge (root vs sub, address, sub-tree, resources)
    sandbox.md           two-axis permission policy, postures, the honest Windows limit
  integrations/        how each host uses personaxis
    claude-code.md       hooks (per-turn learning) + MCP (on-demand) + native subagent
    claude-code-mcp.md   (español) MCP walkthrough
    http-agents.md       personaxis serve — HTTP for non-MCP agents
  commands/            one entry per CLI command (validate, compile, observe, watch, hooks, …)
    README.md            command index
```

## The three-artifact model (start here)

| Artifact | What | Mutability | Who writes it |
|---|---|---|---|
| `.personaxis/[personas/<slug>/]personaxis.md` | The quantitative + persona-prompting **spec** (source of truth) | Versioned; humans, or the persona under governance | `decompile`, governed self-edits |
| `PERSONA.md` (root) · `.personaxis/personas/<slug>/PERSONA.md` (sub) | The **compiled, LLM-facing** document (system-prompt slot #1) | Generated | `compile` |
| `state.json` | Mutable **runtime** dials (mood/affect) | Runtime | the state engine |

Resources (`memory.md`, `memory/`, `references/`, `examples/`, `skills/`, `assets/`,
`policy.yaml`, `self-edits.jsonl`) live next to each `personaxis.md` — the root's in
`.personaxis/`, a sub's in `.personaxis/personas/<slug>/`. The layout **recurses**.

## Status legend used in these docs

- **Implemented** — code + tests in this repo.
- **Best-effort** — works, with an honest limitation stated (e.g. native OS sandboxing).
- **Planned** — designed, not yet wired (always called out explicitly).
