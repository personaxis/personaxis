# Getting started

Build a persona, load it into the agent you already use, and check what it does. Everything here runs
on your machine with your own model key or a local model; there is no account.

## 1. Install

```bash
npm i -g personaxis          # or prefix every command with npx
```

From source: `pnpm install && pnpm run build`, then run `node packages/cli/dist/index.js <cmd>`.

> **Windows / PowerShell.** `running scripts is disabled on this system` is PowerShell blocking npm's
> `.ps1` launcher, as it does for every npm CLI. Run `Set-ExecutionPolicy -Scope CurrentUser
> RemoteSigned` once, or use `personaxis.cmd` or `npx personaxis`.

## 2. Point it at a model

```bash
personaxis config            # a local server (Ollama, LM Studio, llama.cpp) or your own API key
```

Do this before creating a persona. A model writes every field of it, so without one nothing is created,
and it says how to configure one.

## 3. Create a persona

In the folder it will work in:

```bash
personaxis init "A code reviewer who blocks merges without tests and explains every rejection."
```

The model reads the folder, takes what you said, asks what is still missing and writes the persona. Then
open `.personaxis/creation-report.md`. It shows what each field quotes, and its Inferred section lists every
field the model filled without a source saying it, with what it inferred it from: that list is what you
review. [`creating-personas.md`](./creating-personas.md) covers what to give it and how to review it;
`personaxis create <name>` makes another persona beside this one.

## 4. Load it into your agent

`init` already points `CLAUDE.md` and `AGENTS.md` at `PERSONA.md`, so Claude Code and Codex read it here.
For another host:

```bash
personaxis compile --platform hermes                  # or openclaw
```

Or serve it to any MCP host with `npx -y @personaxis/mcp`. The table of how each agent loads a
persona is in the [README](../../README.md#how-each-agent-loads-a-persona).

## 5. See it work

```bash
personaxis
```

Talk to it in plain language. `/persona` shows its definition, `/status` what it is now, `/audit` the
record of everything it did, `/memory` what it remembers and `/doctor` anything wrong with it. Every
view has a shell command with `--json` for scripts: `personaxis status`, `audit`, `memory`, `doctor`.

## In CI

```bash
personaxis validate          # exit 0 valid, 1 schema, 2 policy, 3 conceptual
personaxis lint              # findings, each with the fix
personaxis state rebuild     # the state still matches its record
```

To stop a persona from editing its own definition, `personaxis improve locked`. A `policy.yaml` next to
it can only make the rules stricter.

## Where things live

```
.personaxis/personas/<slug>/personaxis.md     the definition (version this)
.personaxis/personas/<slug>/PERSONA.md        the compiled document an agent reads
.personaxis/personas/<slug>/state.json        the values that move as it works
.personaxis/personas/<slug>/creation-report.md   where every value came from
.personaxis/personas/<slug>/skills/           its procedures
.personaxis/personas/<slug>/references/       its sourced knowledge
```

Next: [`creating-personas.md`](./creating-personas.md) · [`production.md`](./production.md) ·
[`../commands/`](../commands/README.md) · [`../GUARANTEES.md`](../GUARANTEES.md).
