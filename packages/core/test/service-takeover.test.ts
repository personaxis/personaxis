/**
 * E154: when the model starts building by itself a file one of its services only produces after earlier steps, the
 * runtime runs the service instead, through the same approval, and answers the model's call with what ran. A first
 * step's file, an existing file, a second time in the same run, or a service the model already ran, leave the model
 * free to write the file itself.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { compile, DEFAULT_POLICY, PersonaAgent, policyFromPersona } from "../src/index.js";
import type { MapService } from "../src/run/work-map.js";
import { RUN_SERVICE_TOOL, runServiceTool, type RunServiceInput } from "../src/tools/run-service.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pxs-takeover-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const GAME_BUILD: MapService = {
	address: "game-build",
	name: "Game build",
	about: "A small game built to order.",
	delivers: ["GAME.md", "game.html", "CHECK.md"],
	afterFirstStep: ["game.html", "CHECK.md"],
	steps: 3,
};
const REQUEST = "I want a small arcade game about a cat crossing a busy road.";

type Scripted = { name: string; args: Record<string, unknown> };

/** One run with the model's calls scripted, a service that records its runs, and a person who approves everything. */
async function run(script: Scripted[]) {
	const ran: RunServiceInput[] = [];
	const service = runServiceTool({
		services: () => [GAME_BUILD],
		run: async (input) => {
			ran.push(input);
			return "The service ran its three steps and left GAME.md, game.html and CHECK.md.";
		},
	});
	const sent: { role: string; tool_call_id?: string; name?: string; content?: string }[][] = [];
	let at = 0;
	const steps = [...script, { name: "finish", args: { summary: "Done." } }];
	const fetchImpl = (async (url: string, init: { body: string }) => {
		if (String(url).endsWith("/models")) return { ok: true, status: 200, json: async () => ({ data: [] }) };
		sent.push(JSON.parse(init.body).messages);
		const next = steps[Math.min(at++, steps.length - 1)]!;
		const tool_calls = [{ id: `c${at}`, type: "function", function: { name: next.name, arguments: JSON.stringify(next.args) } }];
		return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "", tool_calls }, finish_reason: "tool_calls" }] }) };
	}) as unknown as typeof fetch;
	const agent = new PersonaAgent({
		llm: { endpoint: "http://x/v1", model: "m", fetchImpl },
		policy: { ...DEFAULT_POLICY, workspaceRoot: dir, sandbox: "workspace-write", approval: "on-request" },
		capability: compile(policyFromPersona({ permissions: { sandbox: "workspace-write", approval: "on-request" } }, { personaVersionId: "pv_takeover" })),
		extraTools: [service],
		onApproval: async () => "approve",
	});
	const result = await agent.run(REQUEST);
	const answers = sent.at(-1)!.filter((message) => message.role === "tool");
	return { result, ran, answers };
}

describe("the runtime runs a service when the model starts building what it builds (E154)", () => {
	it("runs the service on the person's request when the model creates a file only a later step makes", async () => {
		const { result, ran, answers } = await run([{ name: "write_file", args: { path: "game.html", content: "<canvas></canvas>" } }]);
		expect(ran).toEqual([{ service: "game-build", brief: REQUEST }]);
		// The model's own write did not run.
		expect(existsSync(join(dir, "game.html"))).toBe(false);
		// Its call is answered under its own id and name, saying what ran instead.
		expect(answers[0]).toMatchObject({ tool_call_id: "c1", name: "write_file" });
		expect(answers[0]!.content).toMatch(/^Not run as you wrote it: game\.html is what the service "Game build" builds/);
		// The record names the service, and that the runtime ran it in place of the write.
		expect(result.calls[0]).toMatchObject({ callId: "c1", tool: RUN_SERVICE_TOOL, verdict: "allowed" });
		expect(result.calls[0]!.reason).toMatch(/run by the runtime in place of write_file/);
	});

	it("leaves a first step's file to the model, since a design document alone can be the request", async () => {
		const { ran } = await run([{ name: "write_file", args: { path: "GAME.md", content: "# Cat road" } }]);
		expect(ran).toEqual([]);
		expect(existsSync(join(dir, "GAME.md"))).toBe(true);
	});

	it("leaves an existing file to the model, since writing over it is fixing or extending it", async () => {
		writeFileSync(join(dir, "game.html"), "<p>old</p>");
		const { ran } = await run([{ name: "write_file", args: { path: "game.html", content: "<p>new</p>" } }]);
		expect(ran).toEqual([]);
	});

	it("takes over once per run, and not at all after the model ran the service itself", async () => {
		const twice = await run([
			{ name: "write_file", args: { path: "game.html", content: "a" } },
			{ name: "write_file", args: { path: "CHECK.md", content: "b" } },
		]);
		expect(twice.ran).toHaveLength(1);
		expect(existsSync(join(dir, "CHECK.md"))).toBe(true);

		rmSync(dir, { recursive: true, force: true });
		mkdirSync(dir, { recursive: true });
		const itself = await run([
			{ name: RUN_SERVICE_TOOL, args: { service: "game-build", brief: "the cat game" } },
			{ name: "write_file", args: { path: "game.html", content: "c" } },
		]);
		expect(itself.ran).toEqual([{ service: "game-build", brief: "the cat game" }]);
		expect(existsSync(join(dir, "game.html"))).toBe(true);
	});
});
