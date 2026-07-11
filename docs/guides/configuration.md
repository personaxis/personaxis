# Configuration, model, endpoint, and API key (dev and prod)

**Configure personaxis once, reuse it in every project.** Your endpoint, model, and API key live in
personaxis's own **global config** (`~/.personaxis/config.json`), the same pattern as `~/.aws/credentials`
or `~/.config/gh/hosts.yml`. Every project you use personaxis in reads it automatically. One resolution
logic serves both dev and production.

```bash
personaxis config set --global local.endpoint https://api.your-provider.com/v1
personaxis config set --global local.model    your-model
personaxis config set --global local.apiKey   <your-key>     # stored user-only (0600), reused everywhere
```

The key is masked when printed and the file is written user-only (`0600`). Prefer `--global` (home dir,
outside any repo). You can also keep the key OUT of the file with `local.apiKeyEnv <ENV_VAR>` (points at
an env var), recommended for CI/prod where the secret comes from the deploy's secret manager.

## Where settings live

| Layer | File / source | Scope |
|---|---|---|
| **global** | `~/.personaxis/config.json` (override the dir with `PERSONAXIS_HOME`) | your machine, configure once, all projects |
| **project** | `<cwd>/.personaxis/config.json` | this project (gitignored by default) |
| **per-persona** | `personas.<slug>` in either config file, or `runtime` in the persona's `personaxis.md` | one persona/sub-persona |
| **env** | `PERSONAXIS_ENDPOINT` / `PERSONAXIS_MODEL` / `PERSONAXIS_API_KEY` | top override (dev & prod) |

## Where files live per OS (cross-platform)

`~` is your home directory on every OS, so the same commands work on Windows, macOS, and Linux:

| What | Windows | macOS / Linux |
|---|---|---|
| personaxis config | `C:\Users\<you>\.personaxis\config.json` | `~/.personaxis/config.json` |
| Claude Code hook | `…\.claude\settings.json` (project) or `C:\Users\<you>\.claude\settings.json` (`--global`) | `~/.claude/settings.json` |
| Codex hook | `…\.codex\hooks.json` or `C:\Users\<you>\.codex\hooks.json` | `~/.codex/hooks.json` |
| Hermes hook | `C:\Users\<you>\.hermes\config.yaml` | `~/.hermes/config.yaml` |
| openclaw hook | `C:\Users\<you>\.openclaw\hooks\personaxis-observe\` | `~/.openclaw/hooks/personaxis-observe/` |

personaxis resolves `~` via the OS home dir, so **you don't configure paths**: the same
`personaxis hooks install --host <host>` writes to the right place on any OS. (Override the personaxis
home with `PERSONAXIS_HOME` if you need to.)

## Precedence

`resolveModel` merges the layers **low → high**, so a more specific layer wins:

```
global.local  <  project.local  <  global.personas[slug]  <  project.personas[slug]  <  frontmatter.runtime  <  ENV
```

A model resolves only when **both** an endpoint and a model are present; otherwise the runtime falls
back to the offline heuristic (no real reasoning) and tells you how to configure one.

## The API key, never required in a file

Resolved in this order:

1. the env var **named by `apiKeyEnv`** (preferred, the key never touches a file), else
2. `PERSONAXIS_API_KEY`, else
3. an inline `apiKey` in a config file (**dev convenience only**: the file must be gitignored).

- **Dev:** set it once, e.g. `config set --global local.apiKeyEnv COHERE_API_KEY` and put the key in
  your shell env / a gitignored `.env`.
- **Prod:** the same `apiKeyEnv` mechanism reads the key from the deploy's **secret manager** (Vercel/
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
/model                              # show the resolved model
/model set endpoint <url>           # writes project config
/model set model <name> global      # append `global` to write the global config
/model set key-env <ENV_VAR>
```

Inspect and verify:

```bash
personaxis config show     # prints project + global + the precedence rule
personaxis config get local.model
```

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
[providers.md](./providers.md) for the `local | byok | agent | remote` providers used by
compile/decompile, and [architecture/deployment.md](./architecture/deployment.md) for how config
feeds each deployment mode.
