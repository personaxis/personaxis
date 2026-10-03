# Host plugins

Plugins that put a persona's policy in front of each tool call in agents whose pre-tool-call point is a plugin, not a
settings-file hook. Each one is a thin translator: it turns the host's event into the `PreToolUse` request that
`personaxis-hook` answers for Claude Code, runs that hook against `personaxis guard`, and turns the answer back into the
host's own way of blocking. Nothing is decided here.

| Host | Plugin | Host's mechanism | Assurance |
|---|---|---|---|
| OpenClaw | `openclaw/` | `api.on("before_tool_call")`, blocks with `{ block: true, blockReason }` | documented |
| Hermes Agent | `hermes/personaxis_guard/` | `ctx.register_hook("pre_tool_call")`, blocks with `{"action": "block", "message"}` | documented |

**Documented, not verified.** Both are written from the hosts' own documentation (read 2026-10-03) and tested against
the real `personaxis guard` socket by calling the plugin the way the documentation says the host calls it. Neither has
been watched firing inside the host itself. Not confirmed from the documentation either: whether OpenClaw needs a
`compat` block in `package.json` and accepts an empty `contracts.tools`, and which fields Hermes's `plugin.yaml` needs
beyond name, version and description. `guard` does not install them, so nothing reports these hosts as armed.

To try one by hand, with `personaxis guard` running in the project:

- OpenClaw: `openclaw plugins install <path to openclaw/>`
- Hermes: copy `hermes/personaxis_guard/` into `~/.hermes/plugins/`, then `hermes plugins enable personaxis_guard`

`PERSONAXIS_HOOK_BIN` can name `hook-bin.js` directly; otherwise `personaxis-hook` is taken from PATH.
