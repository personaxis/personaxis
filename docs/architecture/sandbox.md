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
| **write** | redirects (`>`, `>>`) and `rm` `mv` `cp` `mkdir` `touch` `tee` `dd` `truncate` `chmod` `chown` `ln` `del` `erase` `rmdir`, and PowerShell's `Remove-Item` `Set-Content` `Add-Content` `Out-File` `New-Item` `Copy-Item` `Move-Item` `Rename-Item` `Clear-Content` |
| **network** | `curl` `wget` `nc`/`ncat` `ssh` `scp` `telnet` `ftp` `rsync`, plus `npm install`/`i`/`publish` and `pip install`, and PowerShell's `Invoke-WebRequest` `Invoke-RestMethod` `iwr` `irm` `Start-BitsTransfer` `Send-MailMessage` and `Net.WebClient` |
| **destructive** | `rm -r` and `rm -f` in any combination, `Remove-Item -Recurse` or `-Force`, `rd /s` and `del /s`, `mkfs`, `fdisk`, `shred`, `Format-Volume`, `Clear-Disk`, and the `:(){` fork-bomb |
| **escapesWorkspace** | a path token resolving outside `workspaceRoot` (`/etc/passwd`, `~/x`, `../x`, `"C:\x"`, quoted or not); leading-slash CLI switches like `/t`, `/s` are excluded so `date /t` isn't misflagged |

PowerShell and cmd are shells like any other: Claude Code on Windows runs its commands through a
tool called `PowerShell`, and until 2026-09-11 none of their verbs were in this table.

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

**Protected folders.** A file write into `.git` or `.personaxis`, at any depth below a writable root
and in any letter case, is refused under every posture, `danger-full-access` included, and the
allow-list does not override it (`PROTECTED_SUBPATHS`, `isProtectedUnder`). `.git` is protected whole
because `.git/config` runs code as surely as `.git/hooks` does (`core.hooksPath`, `core.fsmonitor`),
which is also why Codex keeps the whole folder read-only inside a writable root. `.personaxis` holds
the persona's identity, and self-edits are the sanctioned way to change it.

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

## The compiled gate means the same thing

The same posture is enforced a second time, by the policy compiled from the persona
(`packages/core/src/enforcement/policy-compile.ts`). The daemon applies it to every call a host
makes through its hooks or through ACP, and our own loop applies it alongside the tool gate above.
Where both run, the stricter verdict wins.

Until 2026-09-11 the two disagreed. The compiled gate refused every file write under
`workspace-write`, because the action classes cannot say where a write lands and a file write is
`external_write` wherever it points, and it sent every call to a person under `on-request`, reads
included. It now reads two facts about each call, from `callFacts` in
`packages/core/src/enforcement/action-classes.ts`:

- **a known read**: the tool is on an explicit list of tools that only read (ours, and Claude Code's
  `Read`, `Glob`, `Grep`). A name nobody listed is not a read.
- **inside the workspace**: every path the call names resolves inside the workspace root. A path
  that climbs (`..`) is never inside, even when it comes back; a shell command is never inside,
  because what it touches is not in its arguments; and a call that is not a known read has to name
  at least one path, and none under a protected folder. Without a root nothing is inside, which is
  the answer the gate gave before the facts existed.
- **names a place outside**, and **destructive**, for a shell command: its path tokens are scanned
  the way `classifyCommand` scans them, and a token that climbs counts as outside, because a shell
  standing below the root can climb out of it; the command is destructive by the table above.
  Codex's shell, which takes the command as an array, is read too.

With those, posture by posture:

| Call | `read-only` | `workspace-write` | `danger-full-access` |
|---|---|---|---|
| a known read inside the workspace | allow | allow | allow |
| a read outside, a read that names a credential, an unrecognised call | approval axis | approval axis | allow |
| a file write or delete inside the workspace | deny | approval axis | allow |
| an ordinary shell delete (`rm notes.md`) | deny | approval axis | allow |
| a destructive shell delete (`rm -rf`, `Remove-Item -Recurse`), or one that names a place outside | deny | deny | allow |
| a write outside the workspace | deny | deny | allow |
| a write or delete into `.git` or `.personaxis`, by a file tool or named in a shell command | deny | deny | deny |
| a persona's `state.json`, written by a file tool | deny | deny | allow, and the identity axis judges the values |
| a fetch to an allowlisted host, or a tool that only reads a remote | approval axis | approval axis | allow |

Before any posture, the compiled gate applies the deny list, the hard limits, the egress allowlist
and the prohibited behaviours, then refuses a write into the protected folders, and a declared gate
for an action class turns a verdict into a question for a person. So a host that is not on the
allowlist is refused even under `danger-full-access`, and so is a write into `.git` or
`.personaxis`, as the tool gate has always refused it. The one write into `.personaxis` that full
access lets through is a persona's `state.json` written by a file tool, because the identity axis
reads the values it would put there and refuses one outside the persona's envelopes. Written by
shell, nothing reads it, so it is refused.

**Where the compiled gate is stricter than the tool gate, on purpose.** A shell command is never
inside, so under `workspace-write` a write by redirection and a shell command that reaches the
network are refused: the file tools are the way to write. A shell path that climbs and comes back
counts as outside. A read that names a credential is not waved through. A call reached through a
bridge carries no root, so nothing it names is inside.

**What a host's shell can still do that this cannot see.** The facts come from the arguments and
from the working directory the host reports. A host whose shell keeps its directory between calls
can change directory in one call and delete in the next, and the second call alone looks ordinary.

**Where it is looser, and why that holds.** Under `read-only` it refuses what writes, deletes or
spends, and not a call that only reaches out: `network_egress` is also what every MCP tool declares,
and a read-only persona has to be able to read a remote through a tool that says it only reads.
Where that data may go is the egress allowlist's question, and it comes first.

**What the protected folders do not stop.** They are matched on the paths a file tool names and
on the text of a shell command. A command that reaches `.git` without naming it (a `git config`
that sets a hook path, a script that writes the file itself) is not seen by this table; under a
posture that lets arbitrary commands run, that is the operating system's sandbox to stop, where
there is one.

The posture table is pinned in `packages/core/test/gate-postures.test.ts`, and the daemon's side,
including the protected folders once writes inside were allowed, in
`packages/cli/test/daemon-postures.test.ts`.

## OS enforcement, honest limits

The policy gate is the same everywhere; native kernel wrapping (`wrapCommand` →
`security/isolation.ts` `resolveIsolation`) is best-effort on top, only for already-allowed
commands, and **availability-aware** (K.02): a primitive that is not on PATH degrades to `none`
with an honest note, never to a wrapper binary that would fail to spawn.

- **macOS**: Seatbelt via `sandbox-exec` (deny network, writes constrained to the workspace) when
  `sandbox-exec` is present; otherwise policy-only.
- **Linux**: bubblewrap via `bwrap` (read-only bind of `/`, writable workspace, no network) **when
  `bwrap` is on PATH**. If it is not, isolation is honestly `none` and the policy is the control,
  rather than spawning a `bwrap` that does not exist and breaking every command (the bug K.02
  fixed).
- **Windows / other**: **no OS-level sandbox** (Job Objects / restricted tokens / AppContainer are
  not reachable from Node without a native addon): containment is the **policy gate alone**
  (`classifyCommand` + deny-list + `pathEscapesWorkspace`), not kernel isolation.

Where no native primitive exists, enforcement degrades to the policy decision (deny-by-default for
risky ops), never a silent full-access fallback. `describeIsolation` reports which case a given run
is in (`kernel-enforced` vs `policy-only`). This is stated rather than pretended. The OS
isolation itself is specified in a separate document that is not published yet.

## The "no difference" case

A **read-only** command, e.g. getting the date, is classified as neither a write nor network, so it
returns `allow` under all three postures. That is why the postures can look identical for a harmless
command. The difference shows on a **write**: a workspace write is `deny` under `read-only`, `ask`
under `workspace-write` (approval axis), and `allow` under `danger-full-access`.

Tests: `packages/core/test/sandbox.test.ts` (classification, the three postures, file-write escapes,
protected folders, per-persona permissions) and `packages/core/test/gate-postures.test.ts` (the
compiled gate under all twelve combinations of posture).
