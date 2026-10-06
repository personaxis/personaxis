/**
 * Personaxis for OpenClaw: the persona's policy answers OpenClaw's `before_tool_call`, before each tool runs.
 *
 * E43 (2026-10-03). ASSURANCE: documented, NOT verified. Written from OpenClaw's own documentation
 * (docs.openclaw.ai/plugins/hooks/tool-policy, read 2026-10-03): a plugin registers `api.on("before_tool_call", ...)`
 * and blocks by returning `{ block: true, blockReason }`. It has not been watched firing inside OpenClaw, because
 * OpenClaw is not installed on the machine where it was written.
 *
 * It decides nothing itself. It turns OpenClaw's event into the same `PreToolUse` request that `personaxis-hook`
 * already answers for Claude Code (verified there, against a real socket), runs that hook, and turns the answer back:
 * exit 0 lets the call through, exit 2 blocks it with the policy's reason, and anything else blocks too, because a
 * gate that cannot be asked must not read as an allow. The policy itself is served by `personaxis guard` in the
 * project directory.
 *
 * `PERSONAXIS_HOOK_BIN` names the hook to run (a path to `hook-bin.js`, run with this Node); without it,
 * `personaxis-hook` from PATH.
 */
import { spawn } from "node:child_process";

/** OpenClaw's SDK helper when it is there; the plain entry object otherwise. */
let definePluginEntry = (entry) => entry;
try {
	({ definePluginEntry } = await import("openclaw/plugin-sdk/plugin-entry"));
} catch {
	// Outside OpenClaw (tests, a checkout): the entry object is used as is.
}

/** Runs the hook with one PreToolUse request on stdin; resolves with its exit code and stderr. */
export function askHook(request, { bin = process.env.PERSONAXIS_HOOK_BIN } = {}) {
	return new Promise((resolve) => {
		const [command, args] = bin ? [process.execPath, [bin]] : ["personaxis-hook", []];
		let stderr = "";
		let child;
		try {
			child = spawn(command, args, { stdio: ["pipe", "ignore", "pipe"], shell: !bin && process.platform === "win32" });
		} catch (error) {
			resolve({ code: -1, stderr: String(error) });
			return;
		}
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.on("error", (error) => resolve({ code: -1, stderr: String(error) }));
		child.on("close", (code) => resolve({ code: code ?? -1, stderr }));
		child.stdin.end(JSON.stringify(request));
	});
}

/** OpenClaw's event as the PreToolUse request the hook reads. */
export function requestFor(event, ctx, cwd = process.cwd()) {
	return {
		session_id: ctx?.sessionId ?? ctx?.sessionKey ?? "",
		cwd,
		hook_event_name: "PreToolUse",
		tool_name: event?.toolName ?? "",
		tool_input: event?.params ?? {},
		tool_use_id: event?.toolCallId ?? "",
	};
}

/** The hook's answer as OpenClaw's: nothing to let it through, a block with the reason otherwise. */
export async function beforeToolCall(event, ctx, options = {}) {
	const { code, stderr } = await askHook(requestFor(event, ctx, options.cwd), options);
	if (code === 0) return undefined;
	const reason = stderr.trim() || (code === 2 ? "refused by the persona's policy" : "the Personaxis policy could not be asked");
	return { block: true, blockReason: code === 2 ? reason : `the Personaxis policy could not be asked (${reason}); is \`personaxis guard\` running here?` };
}

export default definePluginEntry({
	id: "personaxis-guard",
	name: "Personaxis guard",
	description: "The persona's policy decides each tool call before it runs, served by `personaxis guard`.",
	register(api) {
		api.on("before_tool_call", (event, ctx) => beforeToolCall(event, ctx));
	},
});
