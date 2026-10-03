# personaxis

The command-line tool for [personaxis.md](https://github.com/personaxis/persona.md) personas: define
an AI persona once, in plain, versionable files, and run it as a working agent with its limits
enforced outside the model.

- Every mutable value lives inside a declared range it cannot leave.
- A tool call no permission covers does not execute.
- Everything that happened replays from a hash-chained record.

```bash
npx personaxis proof --quick     # 60 s, offline: the guarantees, run on the real engine
npm i -g personaxis              # puts `personaxis` on your PATH (Node 20.18.1+)
```

## First steps

```bash
personaxis create dev-buddy --from-prompt "A blunt senior code reviewer who explains every rejection."
personaxis --persona .personaxis/personas/dev-buddy/personaxis.md
```

`create` writes the spec (`personaxis.md`), the compiled document a model reads (`PERSONA.md`),
the runtime state (`state.json`) and a creation report that shows which sentence of your brief
produced each number. `personaxis` opens the app: talk in plain language, and the persona uses its
tools inside the sandbox posture you choose.

It runs offline with a heuristic appraiser. For real conversation, point it at any
OpenAI-compatible endpoint, hosted or local:

```bash
personaxis config        # profiles: a local server (Ollama, LM Studio, llama.cpp) or your own key
```

## What else is in the package

| Command | What it is for |
|---|---|
| `personaxis` | the app: talk, `/status`, `/drift`, `/audit`, `/memory`, `/doctor`, `/help` |
| `personaxis -p "<prompt>"` | one headless turn, `--output-format text \| json \| stream-json` |
| `personaxis compile` | write the persona into the file your agent reads: `CLAUDE.md`, `AGENTS.md`, `SOUL.md` |
| `personaxis guard` | enforce the persona's policy on Claude Code and Codex running on this machine |
| `personaxis-acp` | run a persona inside any editor that speaks the Agent Client Protocol |
| `personaxis-hook` | what a host runs before every tool call, answered by `guard` |
| `personaxis-scan` | scan agent config files for injection, dangerous permissions and leaked secrets |

The MCP server is a separate package, [`@personaxis/mcp`](https://www.npmjs.com/package/@personaxis/mcp).

## Documentation

- [README of the repository](https://github.com/personaxis/personaxis#readme)
- [Every command, flag and exit code](https://github.com/personaxis/personaxis/blob/main/docs/commands/README.md)
- [How it works](https://github.com/personaxis/personaxis/blob/main/docs/HOW_IT_WORKS.md)
- [What is guaranteed, and the evidence](https://github.com/personaxis/personaxis/blob/main/docs/GUARANTEES.md)

MIT licensed.
