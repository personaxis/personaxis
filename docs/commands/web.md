# `personaxis web`

Search the web with a configured provider. The same search is offered to personas as the
`web_search` tool, so what a person sees here is what a persona would be handed.

Tavily is the first provider. The provider layer is one interface, so more providers can be
added without the rest of the engine knowing which one answered.

## Usage

```bash
personaxis web search "game design document template"
personaxis web search "platformer level design" -n 8 --deep
personaxis web search "core loop" --json
```

| Flag | Meaning |
|---|---|
| `<query...>` | What to search for, as a person would type it. |
| `-n, --max <n>` | How many results, 1 to 10 (default 5). |
| `--deep` | Ask the provider for better excerpts; costs more per query. |
| `--json` | Print the provider, the query and the results as JSON. |

Exit code is `0` on results, `1` when the provider answered with an error (its status and its own
message, never the key), and `2` when no provider is configured.

## Configuration

With nothing configured, Tavily is used when `TAVILY_API_KEY` is set in the environment. To name
the provider or the variable explicitly, add a `web` block to `.personaxis/config.json`, in the
project or in the home directory (the project's wins):

```json
{
  "web": { "provider": "tavily", "apiKeyEnv": "TAVILY_API_KEY" }
}
```

The key never goes in a config file, only the name of the variable that holds it, the same rule
as the model's `apiKeyEnv`.

## What a persona gets

A persona is offered `web_search` only when a provider resolves, so it is never handed a search
that would fail on its first call, and never under a `read-only` posture, which refuses the
network. The tool:

- sends the query to the configured provider and nowhere else: a persona cannot choose the host;
- is classed `network_egress`, so the persona's compiled policy and any gate it declares on the
  network see it, and its own gate follows [the sandbox postures](../architecture/sandbox.md):
  refused under `read-only`, the approval axis under `workspace-write`, allowed under
  `danger-full-access`;
- returns numbered results, each with its source, labelled as third-party text, and the loop scans
  every tool output for planted instructions before the model reads it.

Reading an arbitrary URL is not offered. That is a connection to a host the call names, which the
egress allowlist refuses by design.
