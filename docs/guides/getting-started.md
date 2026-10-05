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

Do this before creating a persona. Without a model, `create` still produces a valid persona, but most
of it is labelled defaults.

## 3. Create a persona

```bash
personaxis create reviewer --from-prompt "A code reviewer who blocks merges without tests and explains every rejection."
```

Then open `.personaxis/personas/reviewer/creation-report.md`. It shows which sentence of the brief
produced each value, and its Defaults section lists everything Genesis assumed: that list is what you
review. [`creating-personas.md`](./creating-personas.md) covers the other ways in (an interview, your
repository, a SOUL.md or character card, transcripts) and `--research`, which adds sourced references.

## 4. Load it into your agent

```bash
personaxis compile reviewer --platform claude-code    # or codex, openclaw, hermes
```

Or serve it to any MCP host with `npx -y @personaxis/mcp`. The table of how each agent loads a
persona is in the [README](../../README.md#how-each-agent-loads-a-persona).

## 5. See it work

```bash
personaxis --persona .personaxis/personas/reviewer/personaxis.md
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
