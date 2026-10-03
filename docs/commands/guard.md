# `personaxis guard`

Enforce the persona's policy on the coding agents working in a directory, **before** each tool call
runs, on this machine only. No account, no network.

## Usage
```bash
personaxis guard                       # guard the current directory
personaxis guard --dir ~/code/api      # guard another one (repeatable)
```

It keeps running until you stop it (Ctrl+C). While it runs:

1. It reads the persona at `<dir>/.personaxis/personaxis.md` and compiles its policy.
2. It opens a socket on this machine for that directory.
3. It installs a `PreToolUse` hook in each host it knows, which asks that socket before every tool
   call and refuses the call when the policy says no.

| Host | Hook | Assurance |
|---|---|---|
| `claude-code` | `.claude/settings.json` → `PreToolUse` | verified (watched firing) |
| `codex` | `.codex/hooks.json` → `PreToolUse` | documented (not yet watched firing) |

## A call that needs a person

When the policy says a call needs approval, `guard` asks in **its own terminal**: the tool, its
arguments, the directory, and the reason the policy gave. Only `y` or `yes` approves; anything else
declines, and no answer within the policy's time refuses the call. When the terminal cannot answer
(started without one), every such call is refused with that reason. A gated call is never let
through for want of a person.

## When it is not running

The hook refuses every call while nothing answers on the socket, and says to start `guard`. A
directory with no persona is refused rather than given a made-up policy.

## Other agents: OpenClaw and Hermes

Their point before a tool call is a plugin, not a settings file, so `guard` does not install anything for them. The
package carries one plugin for each in `hosts/` (`openclaw/` for `before_tool_call`, `hermes/personaxis_guard/` for
`pre_tool_call`), which ask this same socket through `personaxis-hook`. Both are **documented, not verified**: written
from each host's documentation and tested against `guard`, but not yet watched firing inside the host. How to install
them by hand is in `hosts/README.md`.
