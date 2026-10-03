/**
 * E43: the OpenClaw and Hermes plugins, called the way each host's documentation says it calls them, against the real
 * `personaxis guard` socket and the real `personaxis-hook`.
 *
 * What this proves is our end: each plugin turns its host's event into the PreToolUse request the hook already answers
 * for Claude Code, and turns the answer into its host's way of blocking. What it cannot prove is the host's end, that
 * OpenClaw or Hermes call the plugin as documented; neither is installed here, so both stay `documented`.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const CLI = join(HERE, "..", "dist", "index.js");
const HOOK = join(HERE, "..", "dist", "hook-bin.js");
const HOSTS = join(HERE, "..", "hosts");
const python = ["python", "py"].find((p) => spawnSync(p, ["--version"], { encoding: "utf8" }).status === 0);
const built = existsSync(CLI) && existsSync(HOOK);

let guard: ChildProcess | null = null;
let dir = "";

beforeAll(async () => {
	if (!built) return;
	dir = mkdtempSync(join(tmpdir(), "pxs-hosts-"));
	mkdirSync(join(dir, ".personaxis"), { recursive: true });
	writeFileSync(
		join(dir, ".personaxis", "personaxis.md"),
		"---\nidentity:\n  name: Guarded\npermissions:\n  deny: [\"rm -rf\"]\n  approval: never\n  sandbox: danger-full-access\n---\n# Guarded\n",
	);
	guard = spawn(process.execPath, [CLI, "guard", "--dir", dir], { cwd: REPO, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PERSONAXIS_NO_UPDATE_CHECK: "1", NO_COLOR: "1" } });
	let out = "";
	guard.stdout!.on("data", (c) => (out += c));
	const deadline = Date.now() + 20_000;
	while (!out.includes("guarding.") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
}, 30_000);

afterAll(async () => {
	if (guard && guard.exitCode === null && guard.signalCode === null) {
		const closing = new Promise((r) => guard!.once("close", r));
		guard.kill();
		await closing;
	}
	if (dir) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!built)("the OpenClaw plugin (E43, documented)", () => {
	const load = async () => (await import(pathToFileURL(join(HOSTS, "openclaw", "index.js")).href)) as {
		default: { id: string; register(api: { on(name: string, handler: unknown): void }): void };
		beforeToolCall(event: unknown, ctx: unknown, options: { cwd: string; bin: string }): Promise<{ block: boolean; blockReason: string } | undefined>;
	};

	it("registers on before_tool_call, the event OpenClaw documents for blocking a tool", async () => {
		const plugin = await load();
		const events: string[] = [];
		plugin.default.register({ on: (name) => events.push(name) });
		expect(events).toEqual(["before_tool_call"]);
		expect(plugin.default.id).toBe("personaxis-guard");
	});

	it("blocks what the policy denies, with the policy's reason, and lets the rest through", async () => {
		const { beforeToolCall } = await load();
		const denied = await beforeToolCall({ toolName: "exec", params: { command: "rm -rf build" }, toolCallId: "t1" }, { sessionId: "s" }, { cwd: dir, bin: HOOK });
		expect(denied?.block).toBe(true);
		expect(denied?.blockReason).toMatch(/rm -rf/);

		const allowed = await beforeToolCall({ toolName: "exec", params: { command: "ls" }, toolCallId: "t2" }, { sessionId: "s" }, { cwd: dir, bin: HOOK });
		expect(allowed).toBeUndefined();
	}, 30_000);

	it("blocks when the policy cannot be asked, rather than letting the call through", async () => {
		const { beforeToolCall } = await load();
		const elsewhere = mkdtempSync(join(tmpdir(), "pxs-unguarded-"));
		try {
			const result = await beforeToolCall({ toolName: "exec", params: { command: "ls" } }, {}, { cwd: elsewhere, bin: HOOK });
			expect(result?.block).toBe(true);
		} finally {
			rmSync(elsewhere, { recursive: true, force: true });
		}
	}, 30_000);

	it("blocks when the hook itself cannot run, which is not an exit 2", async () => {
		const { beforeToolCall } = await load();
		const result = await beforeToolCall({ toolName: "exec", params: { command: "ls" } }, {}, { cwd: dir, bin: join(dir, "no-such-hook.js") });
		expect(result?.block).toBe(true);
		expect(result?.blockReason).toMatch(/could not be asked/);
	}, 30_000);
});

describe.skipIf(!built || !python)("the Hermes plugin (E43, documented)", () => {
	/** Imports the plugin in Python, registers it with a fake ctx, and calls the hook as Hermes documents. */
	function callHermes(toolName: string, args: Record<string, unknown>, cwd: string, hook = HOOK): unknown {
		const driver = [
			"import json, sys",
			`sys.path.insert(0, ${JSON.stringify(join(HOSTS, "hermes"))})`,
			"import personaxis_guard as plugin",
			"hooks = {}",
			"class Ctx:",
			"    def register_hook(self, name, fn): hooks[name] = fn",
			"plugin.register(Ctx())",
			"assert list(hooks) == ['pre_tool_call'], hooks",
			`print(json.dumps(hooks['pre_tool_call'](tool_name=${JSON.stringify(toolName)}, args=json.loads(${JSON.stringify(JSON.stringify(args))}), task_id='t', cwd=${JSON.stringify(cwd)})))`,
		].join("\n");
		const run = spawnSync(python!, ["-c", driver], { encoding: "utf8", env: { ...process.env, PERSONAXIS_HOOK_BIN: hook, PERSONAXIS_NODE: process.execPath } });
		if (run.status !== 0) throw new Error(run.stderr);
		return JSON.parse(run.stdout.trim().split(/\r?\n/).pop()!);
	}

	it("blocks what the policy denies with the policy's reason, and returns nothing for the rest", () => {
		const denied = callHermes("terminal", { command: "rm -rf build" }, dir) as { action: string; message: string };
		expect(denied.action).toBe("block");
		expect(denied.message).toMatch(/rm -rf/);
		expect(callHermes("terminal", { command: "ls" }, dir)).toBeNull();
	}, 30_000);

	it("blocks when the policy cannot be asked", () => {
		const elsewhere = mkdtempSync(join(tmpdir(), "pxs-unguarded-"));
		try {
			expect((callHermes("terminal", { command: "ls" }, elsewhere) as { action: string }).action).toBe("block");
		} finally {
			rmSync(elsewhere, { recursive: true, force: true });
		}
	}, 30_000);

	it("blocks when the hook itself cannot run, which is not an exit 2", () => {
		const result = callHermes("terminal", { command: "ls" }, dir, join(dir, "no-such-hook.js")) as { action: string; message: string };
		expect(result.action).toBe("block");
		expect(result.message).toMatch(/could not be asked/);
	}, 30_000);
});
