# @personaxis/core

The engine behind every Personaxis surface: the CLI, the MCP server, the SDK and the app all run on
it, so a persona behaves the same whether an agent loads it by MCP, ACP or a compiled file. It is
framework-agnostic and has no UI.

What it does:

- State inside envelopes: every mutable value of a persona has a declared range; every move is
  clamped to it, gated by the improvement mode and the per-step limit, and written to a
  hash-chained record before the state file is printed from it.
- The living loop: observe, appraise, evolve, remember, with the persona's model; with no model it
  refuses.
- The agent loop: the persona works with tools (files, shell, memory, skills, services,
  delegation) and every call passes the gate first: the sandbox posture, the approval policy, the
  egress rules and the persona's own permissions.
- Memory by kind (episodic, semantic, procedural), with retrieval and consolidation.
- Security: prompt-injection scanning, agent-config scanning, skill review.
- Compilation of the spec into the documents host agents read.

Most applications want [`@personaxis/sdk`](https://www.npmjs.com/package/@personaxis/sdk), the small
typed API over this package. Use `core` directly when you are building a new surface and need the
pieces underneath.

```bash
npm i @personaxis/core
```

The schemas and the validator are in [`@personaxis/spec`](https://www.npmjs.com/package/@personaxis/spec).
How the engine fits together: [HOW_IT_WORKS.md](https://github.com/personaxis/personaxis/blob/main/docs/HOW_IT_WORKS.md)
and the [theorem-to-code map](https://github.com/personaxis/personaxis/blob/main/docs/architecture/math-core.md).

MIT licensed.
