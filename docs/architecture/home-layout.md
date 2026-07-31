# The user-level home: `~/.personaxis` (V6.10)

The CLI works across many projects the way the best agent CLIs do: a global home holds
what belongs to the USER, each project holds what belongs to the PROJECT, and each persona
holds what belongs to the PERSONA. The layout deliberately mirrors the structure Claude
Code itself uses (`~/.claude`), verified on a real installation:

| `~/.claude` (Claude Code) | `~/.personaxis` (personaxis) | Notes |
|---|---|---|
| `settings.json` + per-project settings | `config.json` (global) + `.personaxis/config.json` (project) | layered resolution: global < project < persona < frontmatter < env |
| `projects/<slug>/` (sessions + memory per project) | per-persona `sessions/` + `memory/` next to the spec | personaxis keys by PERSONA (the identity), not by path |
| `history.jsonl` (global prompt history) | `history.jsonl` | one line per user turn: ts, cwd, persona, prompt (truncated) |
| `stats-cache.json` | `stats-cache.json` | per-day, per-model tokens/turns/spend; fed at session close; powers Settings > Stats instantly |
| `plans/` | the persona's own `memory/` + goals | plans are memory for a persona, not a separate artifact |
| `file-history/` (rewind of files) | RESERVED `file-history/` | the seam for artifact-level rewind (compiled docs); state rewind already exists via the mutation log |
| `projects.json` / registry | `registry.json` | the all-projects scope of the Command Center |
| `CLAUDE.md` at project root | `PERSONA.md` at project root (+ baseline block into CLAUDE.md/AGENTS.md/GEMINI.md/copilot-instructions.md) | the discovery chain |

## What writes what

- **`history.jsonl`**: appended by every REPL turn (`dispatchTurn`), best-effort, capped
  prompt length. Cross-project by design: it answers "what have I asked, anywhere".
- **`stats-cache.json`**: `closeSession` folds the session's `usage.byModel` into today's
  bucket. Settings > Stats draws the tokens/day-per-model chart from it without rescanning
  session files; the per-persona activity heatmap still comes from the persona's sessions.
- **`registry.json`**: `registerProject()` on every session start in a project with a
  persona (existing, V5.P0.2).
- **`file-history/`**: reserved, not yet written. When artifact rewind lands, compiled
  outputs get content-addressed copies here before overwrite, so `/rewind` can offer
  document-level restore alongside state-level restore.

All home writes are best-effort: a failure to record never breaks a turn or an exit.
