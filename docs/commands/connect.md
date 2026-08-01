# `personaxis connect`

> ⚠️ **Requires a Personaxis workspace.** This links a machine to a workspace at `personaxis.com`
> (or wherever `PERSONAXIS_BASE_URL` points) and holds a socket open to its gateway. Everything
> local, `validate`, `compile`, `observe`, the REPL, works with no account and no network.

Link this machine, then stream what happens on it to the workspace so a teammate can watch a run,
approve a gate, or steer it from a browser.

```bash
personaxis connect --dir ~/code/api        # link, then hold the wire open
personaxis connect status                  # which workspace, which machine, is the token still good
personaxis connect logout                  # revoke server-side and delete the local token
```

`personaxis login` is an alias of `personaxis connect`.

| Subcommand | Meaning |
|---|---|
| *(none)* | Link the machine if it is not linked, then connect and stay connected. |
| `status` | Print the link and ask the workspace whether the token is still accepted. |
| `logout` | Revoke this machine's token in the workspace, then delete it locally. |

## What the workspace can see

Nothing, until you say so. The scope is the set of directories passed with `--dir`, it is decided
here at the keyboard, and it is stored on this machine. **No message from the workspace can widen
it.** With no `--dir` the machine links and connects with an empty scope, and the command says so
in as many words.

Your repository never moves. What crosses the wire is what the persona did: tool calls, verdicts,
gates, band crossings, the artifact. Not your files.

## Options

| Option | Meaning |
|---|---|
| `--dir <path>` | Expose a directory. Repeatable. Relative paths resolve against the cwd. |
| `--no-open` | Print the approval URL instead of opening a browser (SSH, containers, servers). |
| `--link-only` | Link the machine and exit, without holding the socket open. |
| `--local` (on `logout`) | Forget the token here without revoking it in the workspace. |

## How linking works

The device authorization grant (RFC 8628) with the proof key of PKCE (RFC 7636):

1. The daemon invents a secret and sends the workspace only its SHA-256 hash.
2. You approve the machine in a browser, signed in as yourself. The page shows the machine name
   and OS the daemon claimed.
3. The daemon proves it holds the original secret and collects the token once.

The approval link therefore is not a credential. Whoever sees it can approve a machine they can
already see; they cannot walk away with its token.

The token is stored in the OS credential store where one can be read (macOS Keychain, libsecret on
Linux) and in `~/.personaxis/device.json` with mode `0600` where none can, which today means
Windows. `connect status` tells you which of the two happened, because that is the kind of thing a
tool must not be vague about.

## What enforcement actually is

While `connect` runs, this machine refuses tool calls that the persona's own
limits refuse. Not by asking the model nicely: the host agent runs a hook before
every tool call, the hook asks the daemon over a local socket, and a refused
call never executes.

`connect` installs that hook into `.claude/settings.json` of each `--dir`
(`PreToolUse`, no matcher, so it covers every tool). Your own hooks are left
alone and `connect logout` is not what removes it; the entry is recognised by
its command and can be deleted by hand.

The policy comes from the persona in that directory
(`.personaxis/personaxis.md`): `permissions.deny` and `allow`,
`self_regulation.hard_limits`, `character.prohibited_behaviors`, the sandbox
posture, the approval posture. A directory with no persona has no policy, and
calls made there are refused rather than allowed by default.

Four things are refused without consulting a rule, and each says which one it
was:

| Situation | Rule named |
|---|---|
| The daemon is not running or not answering | the hook's own refusal, with the reason |
| A directory that was never exposed with `--dir` | `out_of_scope` |
| No persona, so no policy | `no_policy` |
| A policy older than its lifetime, with the workspace unreachable | `stale_cache` |

That last one is the one worth understanding. An expired policy is not
"probably still right": its owner may have revoked something ten minutes ago. So
a machine cut off from the workspace for longer than the policy's lifetime stops
allowing, rather than keeping on with limits nobody can update.

A gated call holds the hook open while a person decides in the workspace. That
is the freeze you see there: the tool call has not run, the process is waiting,
and the answer, or the timeout, decides it.

Measured on the development machine: p50 101 ms, p95 114 ms end to end against a
150 ms budget, nearly all of it Node starting up. That is why the hook is its
own small binary (`personaxis-hook`) rather than a subcommand of this CLI.

## When the connection drops

A dropped socket pauses reporting and nothing else. The job keeps running, its events queue
locally, and on reconnect the daemon replays exactly what the workspace has not acknowledged as
durable, in order. Reconnection backs off with full jitter up to 30 seconds, so a gateway deploy
does not bring every daemon back in the same instant.

Two cases end the loop rather than retrying it: the workspace revoking this machine (the local
token is deleted immediately), and the gateway refusing the wire version (the refusal names the
versions and the upgrade command).

## Environment

| Variable | Meaning |
|---|---|
| `PERSONAXIS_BASE_URL` | The workspace. Default `https://personaxis.com`. A local value here implies a local gateway. |
| `PERSONAXIS_GATEWAY_URL` | The socket host on its own. Default `wss://gw.personaxis.com`. |
| `PERSONAXIS_DEVICE_TOKEN` | A token from the environment, for CI or a container with no home directory. Wins over the stored one. |

Connecting needs the WebSocket support built into Node 22 and later. Every other command works on
the same Node floor as before; if this one cannot run, it says so and names the version it found.

## Related

- [`runtime`](./runtime.md) shares this command's HTTP client and credential resolution.
- [`serve`](./serve.md) is the local counterpart: expose a persona over HTTP on this machine only.
