"""Personaxis for Hermes Agent: the persona's policy answers Hermes's ``pre_tool_call``, before each tool runs.

E43 (2026-10-03). ASSURANCE: documented, NOT verified. Written from Hermes Agent's own documentation
(hermes-agent.nousresearch.com/docs/user-guide/features/hooks, read 2026-10-03): a plugin's ``register(ctx)`` calls
``ctx.register_hook("pre_tool_call", fn)``, the callback receives ``tool_name``, ``args`` and ``task_id`` as keyword
arguments, and returning ``{"action": "block", "message": ...}`` stops the tool with that message. Hermes blocks the
tool when the callback times out, rather than letting it run. Not watched firing inside Hermes, because Hermes is not
installed on the machine where it was written.

It decides nothing itself. It turns Hermes's call into the same ``PreToolUse`` request that ``personaxis-hook``
already answers for Claude Code (verified there, against a real socket), runs that hook, and turns the answer back:
exit 0 lets the call through, exit 2 blocks it with the policy's reason, and anything else blocks too, because a gate
that cannot be asked must not read as an allow. The policy itself is served by ``personaxis guard`` in the project
directory.

``PERSONAXIS_HOOK_BIN`` names the hook to run (a path to ``hook-bin.js``, run with ``node``); without it,
``personaxis-hook`` from PATH.
"""

import json
import os
import shutil
import subprocess


def _hook_command():
    bin_path = os.environ.get("PERSONAXIS_HOOK_BIN")
    if bin_path:
        return [os.environ.get("PERSONAXIS_NODE", "node"), bin_path]
    found = shutil.which("personaxis-hook")
    return [found] if found else None


def request_for(tool_name, args, task_id, cwd=None):
    """Hermes's call as the PreToolUse request the hook reads."""
    return {
        "session_id": task_id or "",
        "cwd": cwd or os.getcwd(),
        "hook_event_name": "PreToolUse",
        "tool_name": tool_name or "",
        "tool_input": args if isinstance(args, dict) else {},
        "tool_use_id": "",
    }


def pre_tool_call(tool_name="", args=None, task_id="", **kwargs):
    """None lets the call through; a block with the policy's reason otherwise."""
    command = _hook_command()
    if command is None:
        return {"action": "block", "message": "the Personaxis policy could not be asked: personaxis-hook was not found"}
    try:
        done = subprocess.run(
            command,
            input=json.dumps(request_for(tool_name, args, task_id, kwargs.get("cwd"))),
            capture_output=True,
            text=True,
            timeout=float(os.environ.get("PERSONAXIS_HOOK_TIMEOUT", "60")),
        )
    except Exception as error:  # a gate that cannot be asked is not an allow
        return {"action": "block", "message": f"the Personaxis policy could not be asked ({error}); is `personaxis guard` running here?"}
    if done.returncode == 0:
        return None
    reason = done.stderr.strip()
    if done.returncode == 2:
        return {"action": "block", "message": reason or "refused by the persona's policy"}
    return {"action": "block", "message": f"the Personaxis policy could not be asked ({reason or done.returncode}); is `personaxis guard` running here?"}


def register(ctx):
    ctx.register_hook("pre_tool_call", pre_tool_call)
