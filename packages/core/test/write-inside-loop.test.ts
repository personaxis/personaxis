/**
 * A write inside the project, through every layer our own loop puts in front of it (E59 and E61).
 *
 * Three layers judge a call in `PersonaAgent`: the tool's own gate (`sandbox.ts`), the persona's
 * compiled policy, and the consent matrix. On 2026-09-11 a real service run found that a writer with
 * `workspace-write` could not write a file of its own project under any approval posture: first the
 * compiled policy refused it (E59), then, once that was fixed, the consent matrix asked about it and
 * an unattended run turned the ask into a refusal (E61). The posture tables pin each layer alone;
 * this pins that the three together let the file be written, and still ask or refuse where they
 * should, with the file on disk as the proof rather than a verdict.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { compile, DEFAULT_POLICY, PersonaAgent, policyFromPersona, type LoopEvent } from "../src/index.js";

type Approval = "untrusted" | "on-request" | "on-failure" | "never";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pxs-write-inside-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A model that writes one file and then finishes. */
function writes(path: string): typeof fetch {
	let turn = 0;
	return (async (url: string) => {
		if (String(url).endsWith("/models")) return { ok: true, status: 200, json: async () => ({ data: [] }) };
		turn += 1;
		const call =
			turn === 1
				? { name: "write_file", arguments: JSON.stringify({ path, content: "# Refunds\n" }) }
				: { name: "finish", arguments: JSON.stringify({ summary: "done" }) };
		return {
			ok: true,
			status: 200,
			json: async () => ({ choices: [{ message: { content: "", tool_calls: [{ id: `c${turn}`, type: "function", function: call }] } }] }),
		};
	}) as unknown as typeof fetch;
}

async function runWith(approval: Approval, path: string, answer?: "approve" | "deny") {
	const asked: string[] = [];
	const events: LoopEvent[] = [];
	const permissions = { sandbox: "workspace-write", approval };
	const agent = new PersonaAgent({
		llm: { endpoint: "http://x/v1", model: "m", fetchImpl: writes(path) },
		policy: { ...DEFAULT_POLICY, workspaceRoot: dir, sandbox: "workspace-write", approval },
		capability: compile(policyFromPersona({ permissions }, { personaVersionId: "pv_write" })),
		...(answer
			? {
					onApproval: async (call: { name: string }) => {
						asked.push(call.name);
						return answer;
					},
				}
			: {}),
	});
	agent.bus.on((event) => events.push(event));
	await agent.run("write the reference");
	const verdict = events.find((e) => e.type === "tool-verdict" && e.tool === "write_file") as
		| { decision: string; reason: string }
		| undefined;
	return { verdict, asked, written: existsSync(join(dir, path)) };
}

describe("a write inside the project, through the tool gate, the compiled policy and consent", () => {
	for (const approval of ["never", "on-failure"] as const) {
		it(`is written under workspace-write + ${approval}, and nobody is asked`, async () => {
			const { verdict, asked, written } = await runWith(approval, "docs/refunds.md", "deny");
			expect(verdict?.decision).toBe("allow");
			expect(asked).toEqual([]);
			expect(written).toBe(true);
			expect(readFileSync(join(dir, "docs/refunds.md"), "utf8")).toBe("# Refunds\n");
		});
	}

	for (const approval of ["on-request", "untrusted"] as const) {
		it(`is asked about under workspace-write + ${approval}, and written only on a yes`, async () => {
			const yes = await runWith(approval, "docs/refunds.md", "approve");
			expect(yes.asked).toEqual(["write_file"]);
			expect(yes.written).toBe(true);
		});
	}

	it("is not written when the person says no", async () => {
		const no = await runWith("on-request", "docs/refunds.md", "deny");
		expect(no.asked).toEqual(["write_file"]);
		expect(no.written).toBe(false);
	});

	it("is not written when nobody is there to ask, which is what a service meets", async () => {
		const nobody = await runWith("on-request", "docs/refunds.md");
		expect(nobody.written).toBe(false);
	});

	it("never writes the persona's own files, even with nobody to be asked", async () => {
		const own = await runWith("never", ".personaxis/personaxis.md", "approve");
		expect(own.verdict?.decision).toBe("deny");
		expect(own.written).toBe(false);
	});

	it("never writes outside the project", async () => {
		const out = await runWith("never", "../outside-the-project.md", "approve");
		expect(out.verdict?.decision).toBe("deny");
		expect(existsSync(join(dir, "..", "outside-the-project.md"))).toBe(false);
	});
});
