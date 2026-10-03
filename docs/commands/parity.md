# App ↔ command-line parity

Every capability has two doors over the same engine: a view or command inside the app (menus,
arrows, live refresh) and a command a coding agent, a script or CI can call, in plain text or
JSON. Agents cannot drive menus, so they get flags. Inside the app, an unknown `/name` runs
`personaxis <name>`, and an old command that became a tab says where it went (`/help moved`).

| Capability | Inside the app | Outside (agents, CI) | Machine-readable |
|---|---|---|---|
| Talk one turn | chat | `personaxis -p "<prompt>"` | `--output-format json \| stream-json` |
| Status, config, usage | `/status` | `personaxis status`, `personaxis model` | `--json` on both |
| Context breakdown | `/context` | (session-bound; `-p --output-format json` meters a turn) | stream-json events |
| Drift | `/drift` | `personaxis drift`, `personaxis state drift` | `--json`; `state drift` exits 2 past a threshold |
| State history and rewind | `/audit → Timeline` | `personaxis state show`, `personaxis state rewind <n>` | `--json` |
| Integrity and replay | `/audit → Integrity` | `personaxis audit --tab Integrity` | `--json` |
| Sessions | `/resume` | `personaxis --resume <id>`, `--continue` | session files (JSONL) |
| Memory | `/memory` | `personaxis memory`, `personaxis observe` | `--json` |
| Goal | `/persona → Evolution` | `personaxis goal [text]`, `goal --clear` | `--json` |
| Improvement mode | `/persona → Evolution` | `personaxis improve <mode>` | text verdict |
| Review queue | `/persona → Evolution` | `personaxis review [approve\|reject] [id]` | `--json` |
| Doctor, validate, lint | `/doctor` | `personaxis doctor`, `validate`, `lint` | `--json`; exit codes (five-status contract) |
| Model | `/model` | `personaxis model`, `model set <name> [--persona <slug>] [--project]` | `model --json` |
| Host hooks | `/status → Daemons` | `personaxis hooks install --host <h>`, `hooks check` | text and exit code |
| Skills | `/skill` | `personaxis skills list \| pull` | skills-manifest.json |
| Proof | `/doctor → Proof` | `personaxis proof --auto [--quick] [--demo] [--persona <p>]` | exit 0 only if every check passed |
| Create | `/create` | `personaxis create --from-* --yes [--json] [--no-polish]` | `--json` (spec, gates, provenance) |
| Compile | `/compile` | `personaxis compile [slug] [--platform <host>]` | manifest.json hashes |
| Serve over HTTP | `/status → Daemons` | `personaxis serve -p <spec> [--host] [--token]` | HTTP endpoints |
| Background tasks | `/bg` | task records and `.out` stream-json under `.personaxis/tasks/` | JSONL events |
| Fleet | `/menu → All my projects` | `personaxis ps`, `personaxis overseer show` | `.live.json` markers |
| Attestation | (command line only) | `personaxis attest [--check] [--ttl]` | `--format vc \| a2a` |

Known gap: `/context` has no command-line twin, because what it measures belongs to a live
session.
