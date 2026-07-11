# Providers, how compile/decompile reaches a model

`compile` and `decompile` (and provider-driven self-improvement) turn a prompt into a document by
running it through a **provider**. There are four. The provider is chosen by the `provider` key in
`.personaxis/config.json` (project scope), or an explicit `--provider` on the command; if unset it
defaults to **`agent`** (no network, no setup).

> **Provider ≠ model resolution.** The provider is only for the compile/decompile path. The *living
> loop* (the per-turn appraiser behind the REPL, `observe`, `watch`) resolves its model separately via
> `resolveModel`, see [configuration.md](./configuration.md). The two are configured independently.

## The four providers

| Provider | Talks to | Key / token | When to use |
|---|---|---|---|
| `agent` (default) | the **active coding agent** (Claude Code / Codex), no network call | none | Inside a coding-agent session; zero config |
| `local` | any **OpenAI-compatible** `/chat/completions` endpoint | optional bearer | Ollama / llama.cpp / LM Studio, or a hosted OpenAI-compatible API (Groq/OpenRouter/Cohere) |
| `byok` | your own **Anthropic or OpenAI** account | env var | You have an Anthropic/OpenAI key and want their models directly |
| `remote` | **Personaxis-hosted** models (paid) | env token | You want managed inference, no local server |

## `agent`, the default, no network

Does not call any API. `compile` writes the prompt to `.personaxis/.tmp/<hash>.prompt.md` and stops
with a message; the active coding agent reads that file, runs it with its own model, and writes the
result to `.personaxis/.tmp/<hash>.out.md`. Re-running the command (or passing `--from-file`) applies
the result. This is why it needs no key: the host's model does the work.

## `local`, any OpenAI-compatible endpoint

Config keys under `local`: `endpoint` (default `http://localhost:11434/v1`), `model` (default
`llama3.1`), and either `apiKey` or, preferred, an env var. Env overrides, the same ones the REPL
appraiser reads, win: `PERSONAXIS_ENDPOINT`, `PERSONAXIS_MODEL`, `PERSONAXIS_API_KEY` (sent as
`Authorization: Bearer`, only if present, so a keyless local server just works).

```bash
personaxis config set provider local
personaxis config set local.endpoint http://localhost:11434/v1
personaxis config set local.model llama3.1
```

## `byok`, your Anthropic / OpenAI account

Config keys under `byok`: `apiProvider` (`anthropic` | `openai`, default `anthropic`) and `model`
(default `claude-sonnet-4-6` for Anthropic, `gpt-4.1` for OpenAI). The key is read from
`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` in your environment and is **never** written to a config file.

```bash
personaxis config set provider byok
personaxis config set byok.apiProvider anthropic   # or openai
personaxis config set byok.model claude-sonnet-4-6
```

## `remote`, Personaxis-hosted (paid)

Config keys under `remote`: `apiBase` (default `https://api.personaxis.com`) and `model`. The auth
token is read from `PERSONAXIS_API_TOKEN` (sign in at personaxis.com to get one); it is never stored
in a config file. The request goes to `<apiBase>/api/v1/spec/run`.

```bash
personaxis config set provider remote
personaxis config set remote.apiBase https://api.personaxis.com
```

## See also

- [configuration.md](./configuration.md), model/endpoint/key resolution for the living loop.
- [architecture/deployment.md](./architecture/deployment.md), how each deployment mode uses config.
