# personaxis

The command-line tool for [personaxis.md](https://github.com/personaxis/persona.md) personas. A persona
is the whole way a professional works: its procedures, criteria, tools, sourced knowledge and what it
has learned, kept in plain files. `personaxis create` builds one, `personaxis compile` puts it where
Claude Code, Codex, OpenClaw or Hermes read it, and `personaxis` runs it on your machine. Its values
stay inside the ranges you declare, a tool call no permission covers does not run, and every change is
in a hash-chained record you can replay.

```bash
npx personaxis proof --quick     # a few seconds, offline: the engine's own checks on a throwaway persona
npm i -g personaxis              # puts `personaxis` on your PATH (Node 20.18.1+)
```

## First steps

```bash
personaxis create reviewer --from-prompt "A code reviewer who blocks merges without tests and explains every rejection."
personaxis compile reviewer --platform claude-code
```

`create` writes the definition (`personaxis.md`), the compiled document a model reads (`PERSONA.md`),
the moving values (`state.json`) and a creation report that shows which sentence of your brief produced
each number and labels every default. Without a configured model most of the persona is labelled
defaults, so set one first:

```bash
personaxis config        # a local server (Ollama, LM Studio, llama.cpp) or your own key
```

## What else is in the package

| Command | What it is for |
|---|---|
| `personaxis` | the app: talk in plain language, `/status`, `/audit`, `/memory`, `/doctor`, `/help` |
| `personaxis -p "<prompt>"` | one headless turn, `--output-format text \| json \| stream-json` |
| `personaxis compile` | write the persona where your agent reads it: `CLAUDE.md`, `AGENTS.md`, `SOUL.md` |
| `personaxis-acp` | run a persona inside any editor that speaks the Agent Client Protocol |
| `personaxis guard` | apply the persona's policy to Claude Code and Codex on this machine, before each tool call |
| `personaxis-hook` | what a host runs before each tool call; `guard` answers it |
| `personaxis-scan` | scan agent config files for injection, dangerous permissions and leaked secrets |

To load a persona over MCP (Claude Code, Codex), use the separate package
[`@personaxis/mcp`](https://www.npmjs.com/package/@personaxis/mcp), which serves 16 tools.

## Documentation

- [README of the repository](https://github.com/personaxis/personaxis#readme)
- [Every command, flag and exit code](https://github.com/personaxis/personaxis/blob/main/docs/commands/README.md)
- [How it works](https://github.com/personaxis/personaxis/blob/main/docs/HOW_IT_WORKS.md)
- [What is guaranteed, and the evidence](https://github.com/personaxis/personaxis/blob/main/docs/GUARANTEES.md)

MIT licensed.
