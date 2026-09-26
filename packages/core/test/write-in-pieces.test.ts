/**
 * E139: a file too long for one reply can be sent in pieces, and the second piece adds to the first.
 *
 * Measured on 2026-09-26: after the cut message of E137 said "append the rest with another call", Qwen3.5-9B
 * split `game.html` and sent the second part with `write_file`, which replaced the first; four of fourteen
 * `long-job` runs delivered a page that began halfway through its script. These run the real tool on real
 * files: the pieces join, the checks read the whole file and not the piece, an append goes through the same
 * gate as a write, and the cut message names the argument only for the tool that has it.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_POLICY, PersonaAgent } from "../src/index.js";
import { localExecution, noExecution } from "../src/ports/execution.js";
import { writeFileTool } from "../src/tools/builtin/write-file.js";
import type { ToolSpec } from "../src/tools/registry.js";
import type { Policy } from "../src/sandbox.js";

function workspace(): Policy {
	return { sandbox: "workspace-write", approval: "never", allow: [], deny: [], workspaceRoot: mkdtempSync(join(tmpdir(), "pxs-e139-")) };
}
const execution = localExecution();

const FIRST = ["<!doctype html>", "<canvas id=c></canvas>", "<script>", "const state = {", "  catX: 50,", ""].join("\n");
const REST = ["  speed: 2,", "};", "requestAnimationFrame(function tick() { state.catX += state.speed; requestAnimationFrame(tick); });", "</script>", ""].join("\n");

describe("a file sent in pieces (E139)", () => {
	it("the second piece with append: true adds to the first, and the file is whole", async () => {
		const policy = workspace();
		await writeFileTool.execute({ path: "game.html", content: FIRST }, policy, execution);
		const said = await writeFileTool.execute({ path: "game.html", content: REST, append: true }, policy, execution);
		expect(readFileSync(join(policy.workspaceRoot, "game.html"), "utf-8")).toBe(FIRST + REST);
		expect(said).toMatch(/^appended \d+ bytes to .*game\.html \(now \d+ bytes\)/);
		expect(said).toContain(`(now ${Buffer.byteLength(FIRST + REST)} bytes)`);
	});

	it("the syntax check reads the whole file, not the piece: the rest alone would not compile, joined it does", async () => {
		const policy = workspace();
		const half = await writeFileTool.execute({ path: "game.js", content: "const state = {\n  x: 1,\n" }, policy, execution);
		expect(half).toContain("does not compile now");
		const rest = "  y: 2,\n};\n";
		const joined = await writeFileTool.execute({ path: "game.js", content: rest, append: true }, policy, execution);
		expect(joined).toMatch(/^appended /);
		expect(joined).not.toContain("does not compile now");
		// The same piece written on its own is broken, which is what a check of the piece would have said.
		const alone = await writeFileTool.execute({ path: "rest.js", content: rest }, policy, execution);
		expect(alone).toContain("does not compile now");
	});

	it("append creates a missing file, and without it a write still replaces", async () => {
		const policy = workspace();
		await writeFileTool.execute({ path: "notes/a.md", content: "one\n", append: true }, policy, execution);
		expect(readFileSync(join(policy.workspaceRoot, "notes", "a.md"), "utf-8")).toBe("one\n");
		await writeFileTool.execute({ path: "notes/a.md", content: "two\n" }, policy, execution);
		expect(readFileSync(join(policy.workspaceRoot, "notes", "a.md"), "utf-8")).toBe("two\n");
	});

	it("an append goes through the same gate as a write", () => {
		const policy = { ...workspace(), sandbox: "read-only" as const };
		const write = writeFileTool.gate({ path: "game.html", content: "x" }, policy);
		const append = writeFileTool.gate({ path: "game.html", content: "x", append: true }, policy);
		expect(append.decision).toBe(write.decision);
		expect(append.decision).not.toBe("allow");
		const outside = writeFileTool.gate({ path: "../escape.html", content: "x", append: true }, workspace());
		expect(outside.decision).not.toBe("allow");
	});

	it("a port with nowhere to run refuses an append too", async () => {
		const policy = workspace();
		const said = await writeFileTool.execute({ path: "game.html", content: REST, append: true }, policy, noExecution("no sandbox is up"));
		expect(said).toMatch(/^error: /);
	});
});

const allow = { decision: "allow" as const, reason: "", class: { writesFiles: false, network: false, destructive: false, escapesWorkspace: false } };
const CUT = '{"path":"game.html","content":"<!doctype html>\\n<style>body{margin:0;pad';

/** One turn whose first reply is a cut call to `name`, and what the loop answered it. */
async function cutMessageFor(name: string): Promise<string> {
	let turn = 0;
	const replies = (async (_url: string, init: { body?: string }) => {
		const asked = String(init?.body ?? "").length > 0;
		if (asked) turn += 1;
		const body =
			asked && turn === 1
				? { choices: [{ message: { content: "", tool_calls: [{ id: "1", type: "function", function: { name, arguments: CUT } }] } }] }
				: { choices: [{ message: { content: "ok" } }] };
		return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => body };
	}) as unknown as typeof fetch;
	const tool = {
		name,
		description: "a tool",
		parameters: { type: "object", additionalProperties: false, required: ["path", "content"], properties: { path: { type: "string" }, content: { type: "string" } } },
		isReadOnly: false,
		isConcurrencySafe: false,
		gate: () => allow,
		execute: async () => "done",
	} as ToolSpec;
	const agent = new PersonaAgent({
		llm: { endpoint: "http://x/v1", model: "m", apiKey: "k", fetchImpl: replies },
		policy: { ...DEFAULT_POLICY, sandbox: "danger-full-access", approval: "never" },
		personaBody: "you write files",
		extraTools: [tool],
		maxSteps: 3,
	});
	const outputs: string[] = [];
	agent.bus.on((e) => {
		if (e.type === "tool-result") outputs.push(String(e.output ?? ""));
	});
	await agent.run("build me a game");
	return outputs[0] ?? "";
}

describe("the cut message names what exists (E139)", () => {
	it("for write_file it names append: true and the order", async () => {
		const said = await cutMessageFor("write_file");
		expect(said).toContain("arrived cut off");
		expect(said).toContain("append: true");
		expect(said).toContain("in order");
	});

	it("for a tool that cannot join pieces it does not ask to append", async () => {
		const said = await cutMessageFor("save_note");
		expect(said).toContain("arrived cut off");
		expect(said).not.toMatch(/append/i);
		expect(said).toContain("less in one call");
	});
});
