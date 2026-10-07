# Configuration: model, endpoint and API key

Configure the model once, globally, and every project reads it. Your endpoint, model and API key live in
personaxis's own global config (`~/.personaxis/config.json`), the same pattern as `~/.aws/credentials`
or `~/.config/gh/hosts.yml`. One resolution logic serves both development and production.

```bash
personaxis config set --global local.endpoint https://api.your-provider.com/v1
personaxis config set --global local.model    your-model
personaxis config set --global local.apiKey   <your-key>     # stored user-only (0600), reused everywhere
```

The key is masked when printed and the file is written user-only (`0600`). Prefer `--global` (home dir,
outside any repo). You can also keep the key out of the file with `local.apiKeyEnv <ENV_VAR>` (points at
an env var), recommended for CI/prod where the secret comes from the deploy's secret manager.

## Where settings live

| Layer | File / source | Scope |
|---|---|---|
| global | `~/.personaxis/config.json` (override the dir with `PERSONAXIS_HOME`) | your machine, configure once, all projects |
| project | `<cwd>/.personaxis/config.json` | this project (gitignored by default) |
| per-persona | `personas.<slug>` in either config file, or `runtime` in the persona's `personaxis.md` | one persona/sub-persona |
| env | `PERSONAXIS_ENDPOINT` / `PERSONAXIS_MODEL` / `PERSONAXIS_API_KEY` | top override (dev & prod) |

## Where files live per OS (cross-platform)

`~` is your home directory on every OS, so the same commands work on Windows, macOS, and Linux:

| What | Windows | macOS / Linux |
|---|---|---|
| personaxis config | `C:\Users\<you>\.personaxis\config.json` | `~/.personaxis/config.json` |
| Claude Code hook | `<project>\.claude\settings.json` or `C:\Users\<you>\.claude\settings.json` (`--global`) | `~/.claude/settings.json` |
| Codex hook | `<project>\.codex\hooks.json` or `C:\Users\<you>\.codex\hooks.json` | `~/.codex/hooks.json` |
| Hermes hook | `C:\Users\<you>\.hermes\hooks\personaxis-observe\` | `~/.hermes/hooks/personaxis-observe/` |
| openclaw hook | `C:\Users\<you>\.openclaw\hooks\personaxis-observe\` | `~/.openclaw/hooks/personaxis-observe/` |

personaxis resolves `~` via the OS home dir, so you do not configure paths: the same
`personaxis hooks install --host <host>` writes to the right place on any OS. (Override the personaxis
home with `PERSONAXIS_HOME` if you need to.)

## Precedence

`resolveModel` merges the layers from low to high, so a more specific layer wins:

```
global.local  <  project.local  <  global.personas[slug]  <  project.personas[slug]  <  frontmatter.runtime  <  ENV
```

A model resolves only when both an endpoint and a model are present. Without one, a persona does
not answer, evolve or remember: each of those steps refuses and tells you how to configure one.

## The API key

Resolved in this order:

1. the env var named by `apiKeyEnv` (preferred, the key never touches a file), else
2. `PERSONAXIS_API_KEY`, else
3. an inline `apiKey` in a config file (a development convenience only: the file must be gitignored).

- **Dev:** set it once, e.g. `config set --global local.apiKeyEnv COHERE_API_KEY` and put the key in
  your shell env / a gitignored `.env`.
- **Prod:** the same `apiKeyEnv` mechanism reads the key from the deploy's secret manager (Vercel/
  Railway/Fly env, Kubernetes secret, …). Nothing changes in the config; only the source of the env var.

`.personaxis/*` is gitignored (except `personaxis.md`), so a project config with an inline key is not
committed, but prefer `apiKeyEnv` regardless.

## Configure it

Once, globally (recommended):

```bash
personaxis config set --global local.endpoint https://api.your-provider.com/v1
personaxis config set --global local.model    your-model-name
personaxis config set --global local.apiKeyEnv YOUR_API_KEY_ENV_VAR
```

From inside the REPL:

```
/model                              # show the resolved model and open the provider menu
/model set endpoint <url>           # writes the global config (reused everywhere)
/model set model <name> project     # append `project` to write this project's config instead
/model set key-env <ENV_VAR>
```

`/status` has a Config tab with the effective values and where each one comes from.

Inspect and verify:

```bash
personaxis config show     # prints project + global + the precedence rule
personaxis config get local.model
```

## Named profiles and the guided setup

Instead of a single default, keep a library of named profiles and point the default, or any persona,
at one. Editing a profile updates every reference. A profile can be any provider kind. Every cloud
preset also stores an OpenAI-compatible `endpoint`, so the same profile drives both compile and the
live REPL reasoning:

| Wizard choice | Provider | Drives compile? | Drives the live REPL reasoning? |
|---|---|---|---|
| Local / OpenAI-compatible | `local` | yes | yes (Ollama, LM Studio, any OpenAI-compatible URL) |
| OpenAI | `byok` openai | yes | yes (`api.openai.com/v1`) |
| Anthropic | `byok` anthropic | yes | yes (Anthropic's OpenAI-compatibility endpoint) |
| HuggingFace | `local` | yes | yes (HF Inference router, `router.huggingface.co/v1`) |
| Coding agent | `agent` | yes | n/a (no model; hands off to Claude Code / Codex) |

The friendliest path is interactive:

- First run: launching `personaxis` in a folder with no model offers a step-by-step setup
  (pick the provider, then its fields), or `skip` (configure it later).
- Anytime: `personaxis config use <profile>` sets the default, or assigns one to a persona with
  `--persona <slug>`, and `/model` opens the provider menu.

The same is scriptable and CI-friendly:

```bash
# a local OpenAI-compatible profile
personaxis config set profiles.local.endpoint http://localhost:11434/v1
personaxis config set profiles.local.model    llama3.1
# an OpenAI (byok) profile; the endpoint lets the live REPL use it too
personaxis config set profiles.oai.provider    byok
personaxis config set profiles.oai.apiProvider openai
personaxis config set profiles.oai.model       gpt-4o-mini
personaxis config set profiles.oai.endpoint    https://api.openai.com/v1
personaxis config set profiles.oai.apiKeyEnv   OPENAI_API_KEY
personaxis config use  local                   # make it the machine default
personaxis config use  oai --persona cmo       # assign a profile to one persona
```

A project profile of the same name overrides a global one. A config with only `local` (no profiles)
resolves exactly as before, so profiles are additive.

## Per-persona / per-sub-persona models

Give a big persona a strong model and a cheap sub-persona a local one:

```bash
personaxis config set --global personas.cmo.model     strong-model
personaxis config set --global personas.support.endpoint http://localhost:11434/v1
personaxis config set --global personas.support.model  llama3.1
```

…or let the persona declare its own in `personaxis.md` frontmatter:

```yaml
runtime:
  endpoint: http://localhost:11434/v1
  model: llama3.1
  apiKeyEnv: OLLAMA_KEY   # optional
```

Unset per-persona settings fall back to the project/global default. See
[providers.md](./providers.md) for the `local | byok | agent` providers used by
compile/decompile, and [deployment](../architecture/deployment.md) for how config feeds each way of running a persona.

## Persistent tool permissions

Pre-approve or block tools without being asked every time, via `config.permissions` (project rules
concatenate onto global). Patterns are globs (`*` only) matched against the tool name, `name detail`,
and `name:detail`; a `deny` match always wins, an `allow` match auto-approves, everything else falls
back to interactive approval:

```json
{
  "permissions": {
    "allow": ["read", "grep", "bash git *"],
    "deny": ["bash rm *", "bash:curl *"]
  }
}
```

## User hooks (`.personaxis/hooks.json`)

Run your own shell commands on persona lifecycle events. The file lives next to the persona
(`.personaxis/hooks.json`) and maps an event to matcher-scoped command groups. Events:
`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SessionEnd`. The hook
receives the event JSON (`{ hook_event, ... }`) on stdin. `UserPromptSubmit` and `PreToolUse` are
blocking (a hook can veto them by emitting a `{"decision":"block"}` JSON on stdout); the rest are
fire-and-forget. A hook that times out fails open (it warns and never hangs the agent).

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "my-audit-logger" }] }
    ],
    "PreToolUse": [
      { "matcher": "bash", "hooks": [{ "type": "command", "command": "my-bash-gate", "timeout": 3000 }] }
    ]
  }
}
```

These are hooks of personaxis (personaxis calls out to you); the separate `personaxis hooks` command
installs personaxis into a host, the inverse direction.

## Any OpenAI-compatible endpoint

The engine speaks OpenAI-compatible `chat/completions` over HTTP, so it works with any such
endpoint using the same three fields (`endpoint`, `model`, key):

| Provider / mode | Endpoint | Key |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | API key |
| Anthropic (Claude) | `https://api.anthropic.com/v1` (OpenAI-compat surface) | API key |
| Cohere | `https://api.cohere.ai/compatibility/v1` | API key |
| Hugging Face (router) | `https://router.huggingface.co/v1` | HF token |
| Ollama (local) | `http://localhost:11434/v1` | none needed |
| LM Studio (local) | `http://localhost:1234/v1` | none needed |
| llama.cpp / vLLM (local server) | your `http://localhost:<port>/v1` | none needed |

Resolution rules that keep a session from ever stranding:

1. The default profile wins when it is usable (its key resolves, or its endpoint is local).
2. If the default is broken (for example it points at a profile whose key env var is unset),
   resolution falls back to the first usable profile: ones with a real key first, then
   local-no-key ones. `/model` and `describeModel` say when a fallback happened and to which
   profile.
3. Explicit assignments are never silently switched: an env override
   (`PERSONAXIS_ENDPOINT/MODEL/API_KEY`), the spec's `runtime` block, or a per-persona
   assignment resolve verbatim, and their errors surface with an actionable message
   (what failed + how to fix it with `/model` or `personaxis model set`), never a raw
   HTTP dump.
