# Personaxis CLI documentation

Reference for the Personaxis CLI and engine: what each piece does and where its code is. If you want
an agent to load a persona, start with [`integrations/`](integrations/README.md). If you want to build
one, start with [`guides/getting-started.md`](guides/getting-started.md), then
[`HOW_IT_WORKS.md`](HOW_IT_WORKS.md).

The spec itself lives in the `persona.md` repository:
[docs/SPEC.md](https://github.com/personaxis/persona.md/blob/main/docs/SPEC.md) and
[docs/PERSONA_PROMPTING.md](https://github.com/personaxis/persona.md/blob/main/docs/PERSONA_PROMPTING.md).
What is measured, and what is not yet, is in [`GUARANTEES.md`](GUARANTEES.md).

## Map

```
docs/
  HOW_IT_WORKS.md      the overview: the files of a persona, a turn, what is enforced, how agents load it
  CONCEPTS_FAQ.md      six short answers: compile, change over time, memory, sessions, sandbox, create or init
  GUARANTEES.md        what is tested, with the numbers, and what is not
  guides/
    getting-started.md   install, configure a model, create, load into your agent, CI checks
    creating-personas.md which way in for which input, reviewing the creation report, improving a persona
    configuration.md     model, endpoint and key settings: global, project and per persona
    providers.md         the local, byok and agent providers for compile and decompile
    production.md        MCP, SDK and serve in production, and troubleshooting
    recipes.md           starting points for different kinds of work
    agent-usage.md       how an agent drives the CLI from outside the app
    parity.md            what the app and the shell commands each cover
  architecture/
    runtime.md           how input enters, one tick phase by phase, what persists (with code references)
    math-core.md         which module implements which theorem
    genesis.md           how `personaxis create` builds a persona
    compile.md           compile and decompile, output paths, the compiled document
    self-evolution.md    how a persona edits its own definition under its improvement policy
    memory.md            the six memory kinds
    sessions.md          saved conversations, resume, compaction
    sandbox.md           the two-axis permission policy and the postures
    agent-core.md        the agent loop and its tools
    persona-prompting.md how the compiled document is structured for a model
    deployment.md        the ways to run it: SDK, serve, MCP, hooks, watch
    agent-adoption.md    how Claude Code, Codex, OpenClaw and Hermes load a compiled persona
    target-matrix.md     which file each agent reads
    multi-persona.md     a root persona and its sub-personas
    awareness.md         what a persona knows about its own place: root or sub, address, resources
    project-registry.md  how the CLI learns which projects have personas
    presence.md          who is using a persona right now
    multi-device.md      the same persona on several machines
    home-layout.md       what lives in ~/.personaxis
    command-center.md    the menu
    TECH_STACK.md        the libraries and why
  integrations/
    README.md            start here: which agent, and the three-step setup
    claude-code.md       hooks, MCP and a native subagent
    claude-code-mcp.md   registering the MCP server, the tools, a real session
    codex.md             AGENTS.md, the Stop hook, a subagent and MCP
    openclaw.md          SOUL.md, its hook and MCP
    hermes.md            SOUL.md, its hook and MCP
    http-agents.md       personaxis serve, for agents that do not speak MCP
  commands/            one page per command, every flag and exit code
```

## The files next to a persona

| File | What it is | Who writes it |
|---|---|---|
| `personaxis.md` | The definition (source of truth) | You, or the persona under its improvement policy |
| `PERSONA.md` | The compiled document a model reads | `compile` |
| `record.jsonl` | The state: every change, hash-chained | The runtime; append-only |
| `state.json` | A view printed from the record | The runtime; checked by `state rebuild` |

Next to each `personaxis.md` there may also be `memory.md`, `memory/`, `references/`, `examples/`,
`skills/`, `assets/`, `policy.yaml` and `self-edits.jsonl`. The root persona keeps them in
`.personaxis/`, a sub-persona in `.personaxis/personas/<slug>/`, and the layout repeats for each level.
