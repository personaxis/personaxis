/**
 * L14: the first published version works whole on this machine and offers nothing that needs the Personaxis service.
 *
 * Three things are held here. Nothing user-facing announces a command or provider the gating table keeps out (the
 * help, the README, the command docs, the persona template), and typing one says what it is instead of failing. The
 * enforcement that used to start only inside `connect` starts on its own with `guard`, and a real host hook is refused
 * by it with no network. And a call the policy says needs a person is asked at the terminal, or refused when nobody
 * can answer, never let through.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { enforcementSocketPath } from "../src/workspace/enforcement-endpoint.js";
import type { GateRequest } from "../src/workspace/enforcement-service.js";
import { askAtTerminal } from "../src/workspace/terminal-gate.js";
import { GATED_COMMANDS, GATED_PROVIDERS } from "../src/saas-gating.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const CLI = join(HERE, "..", "dist", "index.js");
const HOOK = join(HERE, "..", "dist", "hook-bin.js");
const built = existsSync(CLI) && existsSync(HOOK);
const NAMES = GATED_COMMANDS.flatMap((c) => [c.name, ...c.aliases]);
/** A gated command written as something to run. */
const RUN = new RegExp(`personaxis (${NAMES.join("|")})\\b`);
/** A gated command as a row of a command index; checked in the indexes only, since `skills pull` has its own row. */
const ROW = new RegExp(`^\\| \\[?\`(${NAMES.join("|")})\\b`, "m");
/** Each run of the built CLI costs about a second on Windows. */
const SPAWNS = 60_000;

function cli(args: string[], cwd = REPO) {
	return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env, PERSONAXIS_NO_UPDATE_CHECK: "1", NO_COLOR: "1" } });
}

describe("the gating table (L14)", () => {
	it("keeps out at least what L14 named, written here by hand so emptying the table cannot pass the rest", () => {
		for (const name of ["connect", "login", "pull", "push", "runtime"]) expect(NAMES, name).toContain(name);
		expect(GATED_PROVIDERS).toContain("remote");
	});
});

describe.skipIf(!built)("what this version offers (L14)", () => {
	it("--help lists guard and none of the gated commands", () => {
		const help = cli(["--help"]).stdout;
		expect(help).toMatch(/^\s+guard\b/m);
		for (const name of NAMES) expect(help, `${name} is gated`).not.toMatch(new RegExp(`^\\s+${name}\\b`, "m"));
	}, SPAWNS);

	it("a gated command typed anyway says what it is and what brings it back, with exit 1", () => {
		for (const name of NAMES) {
			const run = cli([name]);
			expect(run.status, name).toBe(1);
			expect(run.stderr, name).toMatch(new RegExp(`personaxis ${name} is not part of this version: it .+\\. It comes back with .+\\.`));
		}
	}, SPAWNS);

	it("the hosted provider is neither offered nor accepted", () => {
		const dir = mkdtempSync(join(tmpdir(), "pxs-gating-"));
		try {
			for (const help of [cli(["config", "--help"], dir).stdout, cli(["config", "set", "--help"], dir).stdout]) {
				for (const provider of GATED_PROVIDERS) expect(help).not.toContain(provider);
			}
			for (const provider of GATED_PROVIDERS) {
				const run = cli(["config", "set", "provider", provider], dir);
				expect(run.status).not.toBe(0);
				expect(run.stderr + run.stdout).toMatch(/Invalid provider/);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, SPAWNS);
});

describe("what the public text announces (L14)", () => {
	const files = [
		join(REPO, "README.md"),
		join(REPO, "packages", "cli", "README.md"),
		join(REPO, "docs", "HOW_IT_WORKS.md"),
		join(REPO, "docs", "integrations", "claude-code.md"),
		...readdirSync(join(REPO, "docs", "commands")).map((f) => join(REPO, "docs", "commands", f)),
	].filter((f) => existsSync(f));

	it("no README, command doc or integration guide tells anyone to run a gated command", () => {
		for (const file of files) {
			const text = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
			expect(text, file).not.toMatch(RUN);
			if (/README\.md$/.test(file)) expect(text, file).not.toMatch(ROW);
		}
	});

	it("the persona template no longer tells its reader to push to recompile", () => {
		const template = readFileSync(join(REPO, "packages", "cli", "templates", "personaxis_template.md"), "utf8");
		expect(template).not.toMatch(/personaxis (push|pull)\b/);
	});

	it("the command docs carry a page for guard, and none for what is gated", () => {
		const pages = readdirSync(join(REPO, "docs", "commands"));
		expect(pages).toContain("guard.md");
		for (const gone of ["connect.md", "push-pull.md", "runtime.md"]) expect(pages).not.toContain(gone);
	});
});

const gate = (over: Partial<GateRequest> = {}): GateRequest => ({
	call_id: "c1",
	tool: "Bash",
	args_text: "npm publish",
	action_class: "external_write",
	required_approvals: 1,
	timeout_seconds: 60,
	route: {},
	reason: "this persona's approval posture is on-request",
	cwd: "/work",
	...over,
});

describe("asking at the terminal (L14)", () => {
	it("with nobody to answer, the gate is unreachable and nothing is asked", async () => {
		let asked = 0;
		const open = askAtTerminal({
			interactive: false,
			ask: async () => {
				asked += 1;
				return "y";
			},
		});
		expect(await open(gate())).toBe("unreachable");
		expect(asked).toBe(0);
	});

	it("only y or yes approves; anything else declines, and no answer in time expires", async () => {
		const answers: Array<string | null> = ["y", "YES", "", "n", "sure", null];
		const open = askAtTerminal({ interactive: true, ask: async () => answers.shift() ?? null });
		const got = [];
		for (let i = 0; i < 6; i++) got.push(await open(gate()));
		expect(got).toEqual(["approved", "approved", "denied", "denied", "denied", "expired"]);
	});

	it("two calls at once are asked one after the other, with the reason and the policy's time", async () => {
		const seen: Array<{ q: string; ms: number }> = [];
		let open = 0;
		let most = 0;
		const ask = async (q: string, ms: number) => {
			open += 1;
			most = Math.max(most, open);
			seen.push({ q, ms });
			await new Promise((r) => setTimeout(r, 20));
			open -= 1;
			return "y";
		};
		const gateFor = askAtTerminal({ interactive: true, ask });
		await Promise.all([gateFor(gate({ args_text: "first" })), gateFor(gate({ args_text: "second", timeout_seconds: 5 }))]);
		expect(most).toBe(1);
		expect(seen[0]!.q).toContain("first");
		expect(seen[0]!.q).toContain("approval posture is on-request");
		expect(seen[1]!.ms).toBe(5000);
	});
});

/** The host's documented PreToolUse payload. */
const call = (cwd: string, tool: string, input: Record<string, unknown>) =>
	JSON.stringify({ session_id: "s", transcript_path: "/tmp/t.jsonl", cwd, permission_mode: "default", hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, tool_use_id: "toolu_1" });

function hook(body: string, socket: string): Promise<{ code: number; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [HOOK, "--socket", socket], { stdio: ["pipe", "pipe", "pipe"] });
		let stderr = "";
		child.stderr.on("data", (c) => (stderr += c));
		child.on("error", reject);
		child.on("close", (code) => resolve({ code: code ?? -1, stderr }));
		child.stdin.end(body);
	});
}

let guard: ChildProcess | null = null;
let dir = "";
afterEach(async () => {
	// A process ended by `kill` has a signalCode and no exitCode; waiting for its close again would wait forever.
	if (guard && guard.exitCode === null && guard.signalCode === null) {
		const closing = new Promise((r) => guard!.once("close", r));
		guard.kill();
		await closing;
	}
	guard = null;
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = "";
});

describe.skipIf(!built)("guard, end to end with the real hook and no network (L14)", () => {
	it("refuses what the policy denies, refuses what needs a person when nobody can answer, and fails closed once stopped", async () => {
		dir = mkdtempSync(join(tmpdir(), "pxs-guard-"));
		mkdirSync(join(dir, ".personaxis"), { recursive: true });
		writeFileSync(
			join(dir, ".personaxis", "personaxis.md"),
			"---\nidentity:\n  name: Guarded\npermissions:\n  deny: [\"rm -rf\"]\n  approval: on-request\n  sandbox: workspace-write\n---\n# Guarded\n",
		);
		// stdin is a pipe, so this terminal cannot answer: a gated call must be refused, not held or let through.
		// Started from the repository, not from the guarded directory, so the directory can be removed afterwards.
		guard = spawn(process.execPath, [CLI, "guard", "--dir", dir], { cwd: REPO, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PERSONAXIS_NO_UPDATE_CHECK: "1", NO_COLOR: "1" } });
		let out = "";
		guard.stdout!.on("data", (c) => (out += c));
		guard.stderr!.on("data", (c) => (out += c));
		const deadline = Date.now() + 20_000;
		while (!out.includes("guarding.") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
		expect(out).toContain("cannot answer");

		const socket = enforcementSocketPath(dir);
		const denied = await hook(call(dir, "Bash", { command: "rm -rf build" }), socket);
		expect(denied.code).toBe(2);
		expect(denied.stderr).toMatch(/rm -rf/);

		// A write inside the workspace: no deny and no sandbox refusal, so it reaches the approval posture, which asks.
		const gated = await hook(call(dir, "Write", { file_path: join(dir, "notes.txt"), content: "hi" }), socket);
		expect(gated.code).toBe(2);
		expect(gated.stderr).toMatch(/nobody to ask/);

		// The hook it installed for the host is ours, in this directory.
		expect(readFileSync(join(dir, ".claude", "settings.json"), "utf8")).toMatch(/PreToolUse/);

		const closing = new Promise((r) => guard!.once("close", r));
		guard.kill();
		await closing;
		const stopped = await hook(call(dir, "Bash", { command: "ls" }), socket);
		expect(stopped.code).toBe(2);
		expect(stopped.stderr).toMatch(/personaxis guard/);
	}, SPAWNS);
});
