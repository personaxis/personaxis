# Codex integration

Codex reads `AGENTS.md` (which references `@PERSONA.md`) and has a `Stop` hook like Claude Code, so
the setup mirrors it. Do the model config step in the [quickstart](./README.md) first (`config set
--global local.*`).

## 1. Compile the persona

```bash
personaxis compile --root
```

Writes `PERSONA.md` and injects `@PERSONA.md` into `AGENTS.md` (Codex's baseline file). Codex reads it
every session.

## 2. Per-turn learning, the Stop hook (on your model)

```bash
personaxis hooks install --host codex            # project → .codex/hooks.json
personaxis hooks install --host codex --global   # user   → ~/.codex/hooks.json
```

Each turn, Codex's `Stop` hook pipes the turn to `personaxis observe --stdin`, which runs one governed
tick on your configured model and recompiles `PERSONA.md` when a coordinate crosses a band, with no
Codex tokens spent. `observe` reads `last_user_message`, or `last_assistant_message` when there is none. Remove it with `hooks uninstall --host codex`.

## 3. Sub-personas as native subagents

```bash
personaxis compile <slug> --platform codex       # → .codex/agents/<slug>.toml
```

Codex adopts the sub-persona as a custom agent (`developer_instructions` from the compiled doc).

## 4. On-demand tools, MCP (optional)

Codex speaks MCP. Register the server so Codex can read/adjust the persona and run a governed tick when
it chooses to (not every turn):

```toml
# ~/.codex/config.toml
[mcp_servers.personaxis]
command = "npx"
args = ["-y", "@personaxis/mcp"]
```

Tool list + trace: [claude-code.md](./claude-code.md) §2 (the same server serves any MCP host).

## Verify

```bash
personaxis observe --observation "the project uses strict TypeScript" --source user --json
```
`ok: true` means the model + wiring are correct.

See also: [README quickstart](./README.md) · [commands/hooks.md](../commands/hooks.md) · [configuration.md](../guides/configuration.md).
