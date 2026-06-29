# Sandbox: the two-axis permission policy

What a persona is allowed to run is decided by a deterministic, two-axis policy engine
(approval × sandbox, the Codex model). The decision is the load-bearing control: a denied
operation never runs.

Source: `packages/core/src/sandbox.ts`.

## Two axes, deny wins

A `Policy` carries a `sandbox` posture, an `approval` mode, and `allow` / `deny` regex lists.
`evaluateCommand` (and `evaluateFileWrite` for write/edit targets) returns `allow | ask | deny`
with fixed precedence:

```
deny-list  >  sandbox hard limits  >  allow-list  >  approval mode
```

**Sandbox postures** (`SandboxMode`):

- `read-only` — denies any write or network command.
- `workspace-write` — denies writes that escape the workspace (`pathEscapesWorkspace`) and
  destructive commands (`rm -rf`, `mkfs`, `shred`, fork-bomb, …); other risky ops are `ask`.
- `danger-full-access` — no wrapping; explicit opt-out.

**Approval modes** (`ApprovalMode`): `untrusted | on-failure | on-request | never` govern the
residual risk once the sandbox limits pass. A persona carries its own posture via the
`permissions` block (`policyFromFrontmatter`), so it brings its sandbox stance to any host.
The REPL applies it fresh each turn (`buildPolicy`) and cycles the posture with **shift+tab**
or `/mode`.

## Honest limit on Windows

There is **no OS-level sandbox on Windows** here — no Seatbelt, no bubblewrap. Containment is
the **policy gate**: command classification (`classifyCommand`) + the deny-list +
`pathEscapesWorkspace`, not kernel isolation. Where a native wrapper exists it is used
best-effort for allowed commands (macOS `sandbox-exec`, Linux `bwrap`, via `wrapCommand`); on
Windows enforcement degrades to the policy decision (deny-by-default for risky ops), never a
silent full-access fallback. This is stated rather than pretended.

## The "no difference" case

A **read-only** command — e.g. getting the date — is classified as neither a write nor
network, so it returns `allow` under all three postures. That is why the postures can look
identical for a harmless command. The difference shows on a **write**: a workspace write is
`deny` under `read-only`, `ask` under `workspace-write`, and `allow` under
`danger-full-access`.

Tests: `packages/core/test/sandbox.test.ts` (classification, the three postures, file-write
escapes, per-persona permissions).
