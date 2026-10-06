/**
 * E36: a call read out of the text is said, by name, once per dialect and run.
 *
 * Seen on 2026-10-03 with qwen3:4b behind a server without its tool parser: every call came back as text, the hermes
 * dialect read them all and the gate governed them, and nothing on screen, in the log or in the record said so. These
 * run the loop with a scripted model that writes its calls the way that model did.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { compile, DEFAULT_POLICY, PersonaAgent, policyFromPersona, type LoopEvent } from "../src/index.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pxs-dialect-report-"));
	writeFileSync(join(dir, "notes.md"), "# Notes\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

type Step = { content?: string; call?: { name: string; args: Record<string, unknown> } };

/** What qwen3:4b wrote when the server had no parser for it (captured raw on 2026-10-03). */
const asText = (path: string) => `<tool_call>\n{"name": "read_file", "arguments": {"path": "${path}"}}\n</tool_call>`;

function scripted(steps: readonly Step[]): typeof fetch {
	let turn = 0;
	return (async (url: string) => {
		if (String(url).endsWith("/models")) return { ok: true, status: 200, json: async () => ({ data: [] }) };
		const step = steps[turn] ?? { content: "done" };
		turn += 1;
		const message = {
			content: step.content ?? "",
			...(step.call ? { tool_calls: [{ id: `c${turn}`, type: "function", function: { name: step.call.name, arguments: JSON.stringify(step.call.args) } }] } : {}),
		};
		return { ok: true, status: 200, json: async () => ({ choices: [{ message, finish_reason: step.call ? "tool_calls" : "stop" }] }) };
	}) as unknown as typeof fetch;
}

async function run(steps: readonly Step[]): Promise<{ events: LoopEvent[]; summary: string }> {
	const permissions = { sandbox: "workspace-write", approval: "never" };
	const agent = new PersonaAgent({
		llm: { endpoint: "http://x/v1", model: "m", fetchImpl: scripted(steps) },
		policy: { ...DEFAULT_POLICY, workspaceRoot: dir, sandbox: "workspace-write", approval: "never" },
		capability: compile(policyFromPersona({ permissions }, { personaVersionId: "pv_dialect" })),
	});
	const events: LoopEvent[] = [];
	agent.bus.on((event) => events.push(event));
	const result = await agent.run("read my notes and tell me what they say");
	return { events, summary: result.summary };
}

describe("a call read out of the text is reported (E36)", () => {
	it("names the dialect once, though two calls were read with it, and the calls still ran", async () => {
		const { events, summary } = await run([{ content: asText("notes.md") }, { content: asText("notes.md") }, { content: "Your notes have one heading." }]);

		const reports = events.filter((e) => e.type === "dialect-read");
		expect(reports).toEqual([{ type: "dialect-read", dialect: "hermes" }]);
		expect(events.filter((e) => e.type === "tool-propose" && e.tool === "read_file")).toHaveLength(2);
		expect(summary).toBe("Your notes have one heading.");
	});

	it("says nothing when the calls came back native", async () => {
		const { events } = await run([{ call: { name: "read_file", args: { path: "notes.md" } } }, { content: "Your notes have one heading." }]);

		expect(events.some((e) => e.type === "dialect-read")).toBe(false);
		expect(events.some((e) => e.type === "tool-propose" && e.tool === "read_file")).toBe(true);
	});
});
