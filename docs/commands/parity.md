# TUI ↔ external parity

> V5.P5.1. The rule: EVERY capability has two doors over the same engine: a miniapp/command
> inside the TUI (menus, arrows, live refresh) and a non-interactive surface a coding agent,
> a script or CI can call (`personaxis <cmd>`, plain text or JSON). Agents cannot drive
> menus; they get flags. The REPL also passes any unknown `/name` through to
> `personaxis <name>`.

| Capability | Inside the TUI | Outside (agents/CI) | Machine-readable |
|---|---|---|---|
| Talk one turn | chat | `personaxis -p "<prompt>"` | `--output-format json \| stream-json` |
| Status / config / usage / stats | `/status` (Settings miniapp) | `personaxis state show`, `personaxis model`, session files | `state show` JSON, sessions JSONL |
| Context breakdown | `/context [all]` | (session-bound; use `-p` format json for turn metering) | stream-json events |
| Drift, both planes | `/drift` view | `personaxis state drift -f <spec>` | exit 2 on exceedance (CI gate) |
| State history / rewind | `/rewind` timeline | `personaxis state rebuild`, `/rewind <n>` textual | mutation_log JSONL |
| Sessions | `/resume` picker | `personaxis --resume <id>` / `--continue` | sessions JSONL |
| Memory | `/memory` browser | `personaxis observe`, memory files | `memory/*.jsonl` |
| Improve mode | `/improve` menu | `personaxis improve <mode>` | text verdict |
| Review queue | `/review` view | `personaxis edit` + `/review approve <id>` textual | self-edits ledger JSONL |
| Doctor / validate / lint | `/doctor [@sub] [net]` | `personaxis validate <file>`, `personaxis lint <file>` | exit codes (5-status contract) |
| Model | `/model` menu | `personaxis model` · `model set <name> [--persona <slug\|main>] [--project]` | `model --json` |
| Hooks | `/hooks` submenu | `personaxis hooks install --host <h> [-g]` | text + exit code |
| Skills | `/skill` miniapp | `personaxis skills list \| pull` | skills-manifest.json |
| Proof | `/proof` (suspension) | `personaxis proof --auto [--quick] [--demo] [--persona <p>]` | exit 0 only if every check passed |
| Create | `/create` (wizard) | `personaxis create --from-* --yes [--json] [--no-polish]` | `--json` (spec+gates+provenance) |
| Compile | `/compile` | `personaxis compile [slug] [--platform <host>]` | manifest.json hashes |
| Serve | `/serve [port]` | `personaxis serve -p <spec> [--host] [--token]` | HTTP endpoints |
| Background tasks | `/bg` + `/tasks` | task records + `.out` stream-json under `.personaxis/tasks/` | JSONL events |
| Fleet | Command Center Fleet (g = all projects) | `personaxis ps` | `.live.json` markers |
| Attestation | (see docs) | `personaxis attest [--check] [--ttl]` | attestation JSON |

Known gaps (tracked, honest): `/context` has no standalone external twin (its inputs are
session-scoped); `drift`/`audit` JSON output beyond exit codes is served by the HTTP surface
(`/persona/state`, `/persona/audit`) rather than flags. If an agent needs one of these as a
flag, file it; the registry pattern makes additions cheap.
