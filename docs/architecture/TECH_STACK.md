# Tech stack, the definitive CLI/TUI platform (Fase R)

Decision record for the replatform, sourced from the July-2026 source-first research wave: four
parallel audits (Claude Code, local install + docs; **Codex CLI**: source clone; **OpenClaw** +
**Hermes**: source; and a verified TypeScript-ecosystem landscape). The condensed decision table
lives in `ARCHITECTURE_REVIEW.md` §15; this document carries the twelve research questions in
full, with the evidence that backs each choice and the rules an implementer must follow.

The strongest meta-signal from the research: **the four leading agent CLIs independently converged
on the same patterns**: two-axis permissions, layered config with explicit precedence, JSONL
session transcripts, hot-reloaded identity files, shell-out hooks. Where they converge, the choice
is a safe bet, not an opinion. Where one of them built custom infrastructure (Codex forking
ratatui), we read it as a *warning*, not an invitation.

---

## 1. General architecture

The target architecture (ARCHITECTURE_REVIEW.md §14) is a **pnpm monorepo with a protocol seam**:

```
@personaxis/spec ──▶ @personaxis/core ──▶ @personaxis/protocol ──▶ consumers
 (schemas +           (engine: loop,        (Op/EventMsg over        ├─ TUI (Ink 7)
  validator +          governance,           JSON-RPC 2.0)           ├─ headless CLI
  universals)          memory, state)                                ├─ MCP server
                                                                     └─ HTTP serve
```

- The **engine never renders**; the **UI never mutates state directly**. Everything crosses the
  protocol seam as a typed operation (SQ, submission queue) or event (EQ, event queue). This is
  Codex's core seam (`codex-rs/core/src/protocol.rs`), adapted to TypeScript discriminated unions.
- One engine process can serve multiple fronts at once (TUI + dashboard + MCP), which is what the
  living persona needs: evolution in one surface is visible in every other.

## 2. Internal separation (packages)

| Package | Role | New in FR? |
|---|---|---|
| `@personaxis/spec` | schemas + validator + universals | no (F2) |
| `@personaxis/core` | governed engine (loop, clamp+audit, memory, sessions) | no |
| `@personaxis/protocol` | Op/EventMsg types + JSON-RPC transport + client | **yes** |
| `@personaxis/tui` | Ink 7 components (`<Sigil/>`, `<AuraBar/>`, transcript, dashboard) | replatformed |
| `personaxis` (cli) | commander surface + REPL shell over protocol | replatformed |
| `@personaxis/mcp`, `@personaxis/sdk`, `@personaxis/evals` | unchanged consumers | no |

Rule: **no deep imports across packages** (already enforced); protocol types are the only
UI↔engine vocabulary.

## 3. Runtime, language, parser

| Choice | Decision | Evidence |
|---|---|---|
| Runtime | **Node ≥22 LTS** for development/npm; **`bun compile` as a binary packager only** | Claude Code ships as a Bun binary; OpenClaw requires Node 22+. bun-compile constraint: **no native addons** and unsigned `.exe` triggers SmartScreen, code-signing certificate budgeted (see §12) |
| Language | **TypeScript** everywhere | every audited project is TS (or Rust, see TUI warning) |
| CLI parser | **commander 13→14**. NO custom parser | MIT, zero-dep; used by Claude Code and OpenClaw (v14). A bespoke parser is pure maintenance cost with no independence gain |

## 4. Reusable components (ports)

Two pieces of the audited codebases are small, self-contained, and directly on-mission:

1. **`tool-call-repair`** (OpenClaw): repairs malformed/truncated LLM tool calls (dangling JSON,
   wrong quoting) before rejecting them, measurable success-rate lift for tool-calling loops on
   weaker models. Self-contained module; port with tests.
2. **Approval state machine** (Codex): the minimal slice `request → deliver → await → gate` for
   tool approvals, so an approval outlives a single prompt/render cycle and can be answered from
   another surface. Port the state machine only, not the Rust event plumbing.

## 5. Critical dependencies (and their risk posture)

| Dep | Version posture | Risk note |
|---|---|---|
| `ink` | 7.x (7.1.0 current at research time) | MIT, active; Claude Code vendors Ink, proof of production viability |
| `yoga-layout` (via ink) | pinned by ink | WASM, compatible with bun-compile (no native addon) |
| `vscode-jsonrpc` | 8.x | battle-tested by VS Code; transport-agnostic |
| `zustand` | 5.x | 24.5M dl/wk, ~4 open issues at research time |
| `zod` | 3.x/4.x | schema single-source for tools registry |
| `marked` + `marked-terminal` | current | markdown render in terminal |
| `shiki` | 4.x, **lazy-loaded** | syntax highlight; cli-highlight is stale (fallback only) |
| `diff` (jsdiff) + `chalk` | current | diffs |
| `ink-text-input` / `ink-select-input` | current | inputs; keep a custom `useInput` fallback, Ink satellites lag core majors |
| `@modelcontextprotocol/sdk` | **pinned 1.x**; planned bump to v2 (released 2026-07-28) | breaking API in v2; migrate deliberately |
| ~~`better-sqlite3`~~ | **FORBIDDEN** | breaks under Bun ABI (bun#16050); bun-compile forbids native addons; persona = git-versionable plain files is a standing owner requirement |
| ~~`keytar`~~ | **FORBIDDEN** | archived upstream; Claude Code's copy is vestigial |
| ~~`blessed`~~ / OpenTUI | rejected | blessed abandoned; OpenTUI pre-1.0 with a Zig-native core (fights bun-compile) |

## 6. TUI

**Ink 7 + yoga.** Scope discipline: replace ONLY `screen.ts` (the REPL screen writer) and the
dashboard render loop. **`visual.ts` is kept verbatim**: its functions are pure
`(theme, values, frame) → string`, which makes them Ink components for free (`<Sigil/>`,
`<AuraBar/>`); zero visual change to the brand identity.

Why not build a renderer: **Codex forked ratatui+crossterm and carries that fork forever**: the
strongest possible warning against a custom renderer for a team of this size.

Streaming architecture (from Codex `tui/src/streaming/` + Ink issue #359 mitigation):

- `<Static>` region for the **terminated transcript**: committed lines go to native scrollback
  and are never re-rendered (same philosophy as the current `screen.ts`).
- A **bounded live region** below it for in-flight output (spinner, current answer, dials).
- **Tokens buffered per frame** (single state update per animation frame, not per token).
- **Newline-gated commit queue with table-holdback**: a line moves from live → Static only when
  its markdown block is complete (a table is held back until it closes) so committed history is
  never visually broken.
- Markdown via marked-terminal; syntax via shiki (lazy import); diffs via jsdiff+chalk.

State: the core **EventBus stays the source of truth**; a thin **zustand** store adapts events for
React consumption. No jotai/valtio, nothing here needs them.

Testing: **ink-testing-library** + vitest. Verification matrix: Windows Terminal, legacy conhost,
macOS Terminal, Linux (see FR.V).

## 7. CLI surface

commander 13→14. Subcommand structure unchanged (validate/lint/compile/…); the REPL becomes a thin
shell that speaks protocol to the engine. Keyboard map configurable later, not FR scope.

## 8. State management & persistence

- **UI state**: EventBus → zustand (thin), per §6.
- **Sessions**: JSONL transcripts with **`parentUuid` threading** (Claude Code's on-disk format,
  verified locally) + a **background queued writer with Flush/Shutdown acks** (Codex's rollout
  writer pattern) so a crash never loses the tail and shutdown is deterministic.
- **Index**: a **derived JSON index** (rebuildable from the JSONL) for fast listing/search.
  **No SQLite**: see §5.
- **Persona state**: unchanged (state.json checkpoint + mutation_log, per SPEC v1.0 §8.3).

## 9. Agent architecture

Unchanged in FR (the PersonaAgent loop is F3 scope); what FR adds is the seam it will run behind:
the agent emits protocol events (`turn.started`, `tool.approval_requested`, `token.delta`, …) and
consumes operations (`op.user_input`, `op.approval_decision`, `op.interrupt`). The approval FSM
port (§4) is the first consumer.

## 10. MCP

stdio (current) + streamable-HTTP (future) via the official SDK, **pinned 1.x** with a planned,
deliberate bump to v2 (2026-07-28 release). `--root` confinement + `--allow-decide`
(proposer≠approver) stay as shipped in F1.

## 11. Design patterns (what pays off, what is rejected)

Adopted (ARCHITECTURE_REVIEW.md §14.2): hexagonal ports **only for storage** (F3), plugin registry
for compile targets (F3), event-driven core (already exists), SQ/EQ protocol seam (FR), partial
event sourcing (mutation_log as replayable ledger). **Rejected**: CQRS, actor frameworks,
ceremonial DDD, custom renderer, custom parser, SQLite.

## 12. Cross-cutting operational choices

| Area | Decision | Evidence / rule |
|---|---|---|
| Hooks v2 | **shell-out contract**: JSON on stdin; exit `0` = ok, `2` = block, other = warn; optional JSON decision on stdout. Six initial events: `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SessionStart`, `SessionEnd`. **Fire-and-forget, a hook can never block the pipeline** | Claude Code's contract; OpenClaw/Hermes convention (folder + manifest + handler). Known FIX carried from research: the Hermes installer must write `~/.hermes/hooks/<name>/HOOK.yaml` (`events: [session:end]`) + `handler.py`, and `agent:end` IS per-turn (our old doc said the opposite) |
| Config | **explicit numeric layer precedence** (MDM=0 < system < enterprise < user < project < session-flags=30) + a **non-overridable policy tier** (governance keys a lower layer cannot relax) | Codex `config_layer_source.rs`; Claude Code managed→user deny-wins, independent convergence |
| Credentials | env vars + OS secure storage; OAuth PKCE (Codex `login/` pattern) reserved for the SaaS. keytar forbidden | §5 |
| Updates | `update-notifier` for the npm install; **binary self-updater** for bun builds: download from GitHub Releases → atomic replace → keep `.old` for rollback. Windows code-signing certificate required | Claude Code leaves `claude.exe.old.*` on disk (verified locally) |
| Supply chain | pnpm: `minimumReleaseAge: 2880` + `onlyBuiltDependencies: []` (shipped in F1); `blockExoticSubdeps` + sigstore verification deferred until the workspace moves to pnpm ≥11 (feature unverifiable on 10.28) | OpenClaw + Hermes adopted post-2026 npm/PyPI worms |
| Identity hot-reload | compile targets document that OpenClaw and Hermes re-read SOUL.md fresh each message, recompiles take effect without restart; Claude Code/Codex read at session start | drives F3's freshness contract |

---

## Verification (FR.V)

- TUI on Windows Terminal, legacy conhost, macOS, Linux.
- ink-testing-library coverage for transcript commit queue (incl. table-holdback) and live region.
- E2E demo: conversation with streaming + dashboard + approval/review queue over the protocol.
- bun-compiled binaries on the 3 OS.
