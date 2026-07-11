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
deny-list  >  danger-full-access  >  sandbox hard limits  >  allow-list  >  approval mode
```

The **workspace** is `policy.workspaceRoot` (defaults to `process.cwd()`); "escaping the workspace"
means a path that resolves outside it.

## Command classification

`classifyCommand` heuristically tags a command on four axes; the postures act on these:

| Class | Matches |
|---|---|
| **write** | redirects (`>`, `>>`) and `rm` `mv` `cp` `mkdir` `touch` `tee` `dd` `truncate` `chmod` `chown` `ln` |
| **network** | `curl` `wget` `nc`/`ncat` `ssh` `scp` `telnet` `ftp` `rsync`, plus `npm install`/`i`/`publish` and `pip install` |
| **destructive** | `rm -rf` (and `rm -…f`), `mkfs`, `fdisk`, `shred`, and the `:(){` fork-bomb |
| **escapesWorkspace** | a path token resolving outside `workspaceRoot` (`/etc/passwd`, `~/x`, `../x`); leading-slash CLI switches like `/t`, `/s` are excluded so `date /t` isn't misflagged |

## Sandbox postures (exact behavior now)

- **`read-only`**: **denies** any command classed write or network. Network under read-only is always
  denied.
- **`workspace-write`**: **denies** a write that escapes the workspace and **denies** destructive
  commands; other risky ops fall through to the approval axis (typically `ask`). Writes *inside* the
  workspace are allowed by the sandbox and governed by approval.
- **`danger-full-access`**: **allows everything except the deny-list** (explicit YOLO). It is checked
  right after the deny-list, before the other hard limits and before approval, so there is **no**
  approval prompt. This was recently fixed so the posture is meaningfully different from
  `workspace-write` (which still asks for risky ops), matching `wrapCommand`'s "full access, no
  wrapping".

## Approval axis

`ApprovalMode` governs the residual risk once the sandbox limits pass:

| Mode | Risky op (write / network / destructive / escaping) |
|---|---|
| `untrusted` | `ask` (confirm any risky op) |
| `on-request` | `ask` |
| `on-failure` | `allow` (pre-approved) |
| `never` | `allow` |

Read-only ops (neither write nor network) are `allow` under every approval mode. A persona carries its
own posture via the `permissions` block (`policyFromFrontmatter`), so it brings its sandbox stance to
any host. The REPL applies it fresh each turn (`buildPolicy`) and cycles the posture with
**shift+tab** or `/mode`.

## OS enforcement, honest limits

The policy gate is the same everywhere; native kernel wrapping (`wrapCommand`) is best-effort on top,
only for already-allowed commands:

- **macOS**: Seatbelt via `sandbox-exec` (deny network, writes constrained to the workspace).
- **Linux**: bubblewrap via `bwrap` (read-only bind of `/`, writable workspace, no network; requires
  `bwrap` on PATH).
- **Windows / other**: **no OS-level sandbox**: containment is the **policy gate alone**
  (`classifyCommand` + deny-list + `pathEscapesWorkspace`), not kernel isolation. Where no native
  wrapper exists, enforcement degrades to the policy decision (deny-by-default for risky ops), never
  a silent full-access fallback. This is stated rather than pretended.

## The "no difference" case

A **read-only** command, e.g. getting the date, is classified as neither a write nor network, so it
returns `allow` under all three postures. That is why the postures can look identical for a harmless
command. The difference shows on a **write**: a workspace write is `deny` under `read-only`, `ask`
under `workspace-write` (approval axis), and `allow` under `danger-full-access`.

Tests: `packages/core/test/sandbox.test.ts` (classification, the three postures, file-write escapes,
per-persona permissions).
