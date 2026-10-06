# The user-level home: `~/.personaxis`

A global home holds what belongs to the user, each project holds what belongs to the project, and
each persona holds what belongs to the persona. The layout follows the structure Claude Code uses
(`~/.claude`):

| `~/.claude` (Claude Code) | `~/.personaxis` (personaxis) | Notes |
|---|---|---|
| `settings.json` + per-project settings | `config.json` (global) + `.personaxis/config.json` (project) | layered resolution: global, project, persona, then spec frontmatter, then environment |
| `projects/<slug>/` (sessions + memory per project) | per-persona `sessions/` + `memory/` next to the spec | personaxis keys by persona, not by path |
| `history.jsonl` (global prompt history) | `history.jsonl` | one line per user turn: ts, cwd, persona, prompt (truncated) |
| `stats-cache.json` | `stats-cache.json` | per-day, per-model tokens/turns/spend; fed at session close; feeds the usage view in `/status` without rescanning sessions |
| `projects.json` / registry | `registry.json` | the cross-project index behind the all-projects scope of the Command Center |
| `CLAUDE.md` at project root | `PERSONA.md` at project root (+ baseline block into CLAUDE.md/AGENTS.md/GEMINI.md/copilot-instructions.md) | the discovery chain |

## What writes what

- `history.jsonl`: appended by every REPL turn (`dispatchTurn`), best-effort, capped
  prompt length. Cross-project by design: it answers "what have I asked, anywhere".
- `stats-cache.json`: `closeSession` folds the session's `usage.byModel` into today's bucket, so
  the tokens-per-day chart reads it without rescanning session files; the per-persona activity
  heatmap still comes from the persona's sessions.
- `registry.json`: `registerProject()` on every session start in a project with a persona.

All home writes are best-effort: a failure to record never breaks a turn or an exit.
