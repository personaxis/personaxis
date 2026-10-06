/**
 * A tool call the model never finished, and what the loop does about it.
 *
 * Measured on 2026-09-11 in a real run: a model asked for a game as one HTML file emitted 2 525
 * bytes ending in the middle of a stylesheet, because its completion hit the token ceiling. The
 * repair pass closed the JSON, the write reported "ok, wrote 2525 bytes", and the model, told it
 * had succeeded, sent the same half-file seven more times until the loop breaker ended the turn.
 * Nothing errored, and the file on disk was broken.
 *
 * Two properties, and they are separate on purpose: the parser must MARK a call it had to close,
 * and the loop must REFUSE to run one and say why in words the model can act on.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_POLICY, PersonaAgent } from "../src/index.js";
import { requestToolCall } from "../src/tool-calling.js";
import type { ToolSpec } from "../src/tools/registry.js";

const allow = { decision: "allow" as const, reason: "", class: { writesFiles: false, network: false, destructive: false, escapesWorkspace: false } };

const writeTool = (record: string[]): ToolSpec =>
	({
		name: "write_file",
		description: "write a file",
		parameters: { type: "object", additionalProperties: false, required: ["path", "content"], properties: { path: { type: "string" }, content: { type: "string" } } },
		isReadOnly: false,
		isConcurrencySafe: false,
		gate: () => allow,
		execute: async (args) => {
			record.push(String(args.content));
			return `wrote ${String(args.content).length} bytes`;
		},
	}) as ToolSpec;

/** An endpoint whose reply carries a tool call whose arguments are cut off mid-string. */
const endpointSaying = (calls: unknown[], content = "") =>
	(async () => ({
		ok: true,
		status: 200,
		headers: new Headers({ "content-type": "application/json" }),
		json: async () => ({ choices: [{ message: { content, tool_calls: calls } }] }),
	})) as unknown as typeof fetch;

const CUT = '{"path":"game.html","content":"<!doctype html>\\n<style>body{margin:0;pad';

describe("a call whose arguments arrived cut off", () => {
	it("is marked as truncated, and a call merely written badly is not", async () => {
		const tools = [writeTool([])];
		const cut = await requestToolCall(
			{ endpoint: "http://x/v1", model: "m", fetchImpl: endpointSaying([{ id: "1", type: "function", function: { name: "write_file", arguments: CUT } }]) },
			[],
			tools,
		);
		expect(cut.toolCalls[0]?.truncated).toBe(true);

		// A trailing comma is a COMPLETE call written badly: repaired, and not truncated.
		const sloppy = await requestToolCall(
			{ endpoint: "http://x/v1", model: "m", fetchImpl: endpointSaying([{ id: "1", type: "function", function: { name: "write_file", arguments: '{"path":"a.md","content":"hi",}' } }]) },
			[],
			tools,
		);
		expect(sloppy.toolCalls[0]?.truncated).toBeUndefined();
		expect(sloppy.toolCalls[0]?.args).toEqual({ path: "a.md", content: "hi" });
	});

	it("is not run, and the model is told it was cut rather than that it worked", async () => {
		const written: string[] = [];
		let turn = 0;
		// Keyed on what is asked, not on a counter: the loop makes a probe call with no body of its
		// own before the turn, and counting made the test answer the probe instead of the turn.
		const replies = (async (_url: string, init: { body?: string }) => {
			const asked = String(init?.body ?? "").length > 0;
			if (asked) turn += 1;
			// First the cut call, then a plain answer, so the turn ends.
			const body =
				asked && turn === 1
				? { choices: [{ message: { content: "", tool_calls: [{ id: "1", type: "function", function: { name: "write_file", arguments: CUT } }] } }] }
				: { choices: [{ message: { content: "I will send it in pieces." } }] };
			return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => body };
		}) as unknown as typeof fetch;

		const agent = new PersonaAgent({
			llm: { endpoint: "http://x/v1", model: "m", apiKey: "k", fetchImpl: replies },
			policy: { ...DEFAULT_POLICY, sandbox: "danger-full-access", approval: "never" },
			personaBody: "you write files",
			extraTools: [writeTool(written)],
			maxSteps: 4,
		});

		const results: Array<{ ok: boolean; output: string }> = [];
		agent.bus.on((e) => {
			if (e.type === "tool-result") results.push({ ok: e.ok, output: String(e.output ?? "") });
		});
		await agent.run("build me a game");

		// The half-file never reached the disk.
		expect(written).toEqual([]);
		expect(results).toHaveLength(1);
		expect(results[0]!.ok).toBe(false);
		expect(results[0]!.output).toContain("arrived cut off");
		// And it says the one thing that actually works.
		expect(results[0]!.output).toContain("smaller pieces");
	});
});
