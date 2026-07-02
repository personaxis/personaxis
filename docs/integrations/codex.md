# Codex integration

Codex reads `AGENTS.md` (which references `@PERSONA.md`) and has a **`Stop`** hook like Claude Code, so
the setup mirrors it. See the [quickstart](./README.md) for the model config step (`config set
--global local.*`) — do that first.

## 1. Identity — always fresh

```bash
personaxis compile --root
```

Writes `PERSONA.md` and injects `@PERSONA.md` into `AGENTS.md` (Codex's baseline file). Codex reads it
every session.

## 2. Per-turn learning — the Stop hook (on your model)

```bash
personaxis hooks install --host codex            # project → .codex/hooks.json
personaxis hooks install --host codex --global   # user   → ~/.codex/hooks.json
```

Each turn, Codex's `Stop` hook pipes the turn to `personaxis observe --stdin`, which runs one governed
tick on **your** configured model and recompiles the identity on drift — zero Codex tokens. `observe`
reads Codex's payload (`last_assistant_message`). Remove it with `hooks uninstall --host codex`.

## 3. Sub-personas — native subagents

```bash
personaxis compile <slug> --platform codex       # → .codex/agents/<slug>.toml
```

Codex adopts the sub-persona as a custom agent (`developer_instructions` from the compiled doc).

## 4. On-demand tools — MCP (optional)

Codex speaks MCP. Register the server so Codex can read/adjust the persona and run a governed tick when
it chooses to (not every turn):

```jsonc
// .codex or Codex MCP config
{ "mcpServers": { "personaxis": { "command": "personaxis-mcp" } } }
```

Tool list + trace: [claude-code.md](./claude-code.md) §2 (the same server serves any MCP host).

## Verify

```bash
personaxis observe --observation "the project uses strict TypeScript" --source user --json
```
`ok: true` means the model + wiring are correct.

See also: [README quickstart](./README.md) · [commands/hooks.md](../commands/hooks.md) · [configuration.md](../configuration.md).
