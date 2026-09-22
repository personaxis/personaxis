/**
 * E106: the turn does not close saying "done" over a delivery the engine has just seen fail.
 *
 * Until 2026-09-22 the loop ran the page the persona had written (`E85`), saw it not start, wrote that in the
 * record, and accepted the completion anyway. The hand-back existed twenty-eight lines below and was reachable
 * only through declared gates, which default to off and which nobody declares. These tests are about the JOIN,
 * so every one of them drives the real loop: a rule that returns the right sentence and a loop that never acts
 * on it look identical from the rule's side, which is the exact shape of the `check_page` fault of `E98`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PersonaAgent, compile, DEFAULT_POLICY, type CompiledPolicy, type ExecutablePolicy, type Policy } from "../src/index.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pxs-e106-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const policy = (over: Partial<Policy> = {}): Policy => ({
	...DEFAULT_POLICY,
	workspaceRoot: dir,
	approval: "never",
	sandbox: "workspace-write",
	...over,
});

function capability(over: Partial<CompiledPolicy> = {}): ExecutablePolicy {
	return compile({
		persona_version_id: "pv_test",
		hash: "h",
		compiled_at: new Date().toISOString(),
		ttl_seconds: 3600,
		deny: [],
		allow: [],
		hard_limits: [],
		prohibited_behaviors: [],
		egress_allowlist: [],
		sandbox: "workspace-write",
		approval: "never",
		gate_rules: [],
		...over,
	} as CompiledPolicy);
}

/** A page whose script does not parse, which is what a bad edit leaves behind. */
const BROKEN = '<!doctype html>\n<canvas id="s"></canvas>\n<script>\nconst state = {\n  x: 0\n};\n  y: 1,\n  z: 2\n};\n</script>\n';

/** The same page, fixed: one object, and a loop that draws. */
const FIXED =
	'<!doctype html>\n<canvas id="s"></canvas>\n<script>\nconst state = { x: 0, y: 1, z: 2 };\nconst ctx = document.getElementById("s").getContext("2d");\nrequestAnimationFrame(function frame() { ctx.fillRect(state.x, 0, 1, 1); requestAnimationFrame(frame); });\n</script>\n';

interface Step {
	readonly tool?: string;
	readonly args?: object;
	readonly text?: string;
}

/** A scripted model that also keeps every set of messages it was sent, so the hand-back can be read. */
function scripted(steps: Step[]): { fetchImpl: typeof fetch; sent: Array<Array<{ role: string; content: string }>> } {
	const sent: Array<Array<{ role: string; content: string }>> = [];
	let i = 0;
	const fetchImpl = (async (url: string, init?: { body?: string }) => {
		if (String(url).endsWith("/models")) return { ok: true, status: 200, json: async () => ({ data: [] }) };
		if (init?.body) sent.push(JSON.parse(init.body).messages ?? []);
		const s = steps[Math.min(i, steps.length - 1)]!;
		i += 1;
		const message = s.tool
			? { content: s.text ?? "", tool_calls: [{ id: `c${i}`, type: "function", function: { name: s.tool, arguments: JSON.stringify(s.args ?? {}) } }] }
			: { content: s.text ?? "" };
		return { ok: true, status: 200, json: async () => ({ choices: [{ message }] }) };
	}) as unknown as typeof fetch;
	return { fetchImpl, sent };
}

const agentOver = (fetchImpl: typeof fetch) =>
	new PersonaAgent({ llm: { endpoint: "http://x/v1", model: "m", fetchImpl }, policy: policy(), capability: capability() });

/**
 * The hand-backs in the transcript, read from the LAST request the model got.
 *
 * From the last one and not from every request flattened: a message pushed into the thread is re-sent with
 * every call after it, so flattening counts one hand-back once per turn that followed it and "handed back
 * twice" would be indistinguishable from "handed back once, three steps ago".
 */
const handBacks = (sent: Array<Array<{ role: string; content: string }>>): string[] =>
	(sent[sent.length - 1] ?? []).filter((m) => m.role === "user" && m.content.includes("does not work")).map((m) => m.content);

describe("a delivery the engine saw fail (E106)", () => {
	it("hands the turn back with the reason, and takes the fix", async () => {
		const { fetchImpl, sent } = scripted([
			{ tool: "write_file", args: { path: "game.html", content: BROKEN } },
			{ tool: "finish", args: { summary: "the game is ready" } },
			// After the hand-back: the persona fixes it and finishes again.
			{ tool: "write_file", args: { path: "game.html", content: FIXED } },
			{ tool: "finish", args: { summary: "fixed, and now it runs" } },
		]);

		const res = await agentOver(fetchImpl).run("make me a game");

		expect(res.finished).toBe(true);
		expect(res.summary).toContain("fixed");
		// The file that survived is the fixed one, and the check the turn reports is green.
		expect(readFileSync(join(dir, "game.html"), "utf8")).toContain("requestAnimationFrame");
		expect(res.delivered?.checks.every((c) => c.passed)).toBe(true);

		const handed = handBacks(sent);
		expect(handed).toHaveLength(1);
		// The reason travels, and since 171a41a it carries the line of the file and quotes it.
		expect(handed[0]).toContain("game.html");
		expect(handed[0]).toMatch(/line \d+/);
	});

	it("hands it back once, and lets the turn close when the persona finishes again unfixed", async () => {
		const { fetchImpl, sent } = scripted([
			{ tool: "write_file", args: { path: "game.html", content: BROKEN } },
			{ tool: "finish", args: { summary: "done" } },
			// Told it does not work, this persona finishes again without touching it.
			{ tool: "finish", args: { summary: "I am leaving it as it is" } },
		]);

		const res = await agentOver(fetchImpl).run("make me a game");

		expect(res.finished).toBe(true);
		// Once. A second hand-back would be the edit-and-recheck loop E103 measured, built by hand.
		expect(handBacks(sent)).toHaveLength(1);
		// And the failure is still reported rather than swallowed by the turn closing.
		expect(res.delivered?.checks.some((c) => !c.passed)).toBe(true);
	});

	it("says nothing when what was left works", async () => {
		const { fetchImpl, sent } = scripted([
			{ tool: "write_file", args: { path: "game.html", content: FIXED } },
			{ tool: "finish", args: { summary: "done" } },
		]);

		const res = await agentOver(fetchImpl).run("make me a game");

		expect(res.finished).toBe(true);
		expect(res.delivered?.checks.every((c) => c.passed)).toBe(true);
		expect(handBacks(sent)).toHaveLength(0);
	});

	it("says nothing about a delivery that has no check of its own", async () => {
		// A prose file is reported unverified BY NAME and is not a failure, so nothing is handed back.
		const { fetchImpl, sent } = scripted([
			{ tool: "write_file", args: { path: "GAME.md", content: "# A game\n\nIt is about a frog.\n" } },
			{ tool: "finish", args: { summary: "done" } },
		]);

		const res = await agentOver(fetchImpl).run("write me a design");

		expect(res.finished).toBe(true);
		expect(res.delivered?.unverified.join(" ")).toContain("GAME.md");
		expect(handBacks(sent)).toHaveLength(0);
	});
});
