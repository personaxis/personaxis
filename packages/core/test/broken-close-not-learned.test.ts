/**
 * E133: a delivery the engine saw broken is not learned as a success.
 *
 * After the one hand-back of E106, a second close is accepted even when the delivery still fails; that is
 * decided and stays. What changed on 2026-09-24 is what the persona LEARNS from such a close. Measured in
 * `e132co`: a persona closed saying "I have fixed the syntax error" with its check failing twice, and its
 * memory recalled that turn as `[success]` on the next one. These drive the real loop with a scripted model
 * and read the memory files, because the rule and the loop acting on it are two different things.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PersonaAgent, compile, DEFAULT_POLICY, readMemory, type CompiledPolicy, type Policy } from "../src/index.js";
import { readProcedural } from "../src/memory-kinds.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pxs-e133-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const policy = (): Policy => ({ ...DEFAULT_POLICY, workspaceRoot: dir, approval: "never", sandbox: "workspace-write" });
const capability = () =>
	compile({
		persona_version_id: "pv", hash: "h", compiled_at: new Date().toISOString(), ttl_seconds: 3600, deny: [], allow: [], hard_limits: [],
		prohibited_behaviors: [], egress_allowlist: [], sandbox: "workspace-write", approval: "never", gate_rules: [],
	} as CompiledPolicy);

const BROKEN = '<!doctype html>\n<canvas id="s"></canvas>\n<script>\nconst state = {\n  x: 0\n  y: 1\n};\n</script>\n';
const FIXED =
	'<!doctype html>\n<canvas id="s"></canvas>\n<script>\nconst state = { x: 0, y: 1 };\nconst ctx = document.getElementById("s").getContext("2d");\nrequestAnimationFrame(function frame() { ctx.fillRect(state.x, 0, 1, 1); requestAnimationFrame(frame); });\n</script>\n';

function scripted(steps: Array<{ tool: string; args: object }>): typeof fetch {
	let i = 0;
	return (async (url: string) => {
		if (String(url).endsWith("/models")) return { ok: true, status: 200, json: async () => ({ data: [] }) };
		const s = steps[Math.min(i, steps.length - 1)]!;
		i += 1;
		const message = { content: "", tool_calls: [{ id: `c${i}`, type: "function", function: { name: s.tool, arguments: JSON.stringify(s.args) } }] };
		return { ok: true, status: 200, json: async () => ({ choices: [{ message }] }) };
	}) as unknown as typeof fetch;
}

/** Four steps, so the success post-mortem's own trigger (steps >= 4) is met whenever the close counts as a success. */
async function turn(page: string, closing: string) {
	const personaPath = join(dir, "personaxis.md");
	writeFileSync(personaPath, "---\nmetadata: { name: a, version: 1.0.0 }\nidentity: { canonical_id: a }\nmemory: { types: { episodic: true, procedural: true } }\n---\nbody");
	let reflected = 0;
	await new PersonaAgent({
		llm: {
			endpoint: "http://x/v1",
			model: "m",
			// A broken page is handed back once (E106) and closed again at step 4; a sound one looks around
			// twice and closes at step 4, so both reach the same post-mortem trigger.
			fetchImpl: scripted(
				page === BROKEN
					? [
							{ tool: "write_file", args: { path: "game.html", content: page } },
							{ tool: "finish", args: { summary: closing } },
							{ tool: "list_dir", args: { path: "." } },
							{ tool: "finish", args: { summary: closing } },
						]
					: [
							{ tool: "write_file", args: { path: "game.html", content: page } },
							{ tool: "list_dir", args: { path: "." } },
							{ tool: "list_dir", args: { path: "." } },
							{ tool: "finish", args: { summary: closing } },
						],
			),
		},
		policy: policy(),
		capability: capability(),
		personaPath,
		postmortem: {
			extract: async () => {
				reflected += 1;
				return null;
			},
		},
	}).run("make the game");
	const runs = readMemory(personaPath).filter((m) => m.tags.includes("agent-run"));
	return { runs, procedural: readProcedural(personaPath), reflected };
}

describe("what a close over a broken delivery teaches (E133)", () => {
	it("is remembered as verification_failed, keeps no how-to, and runs no success post-mortem", async () => {
		const { runs, procedural, reflected } = await turn(BROKEN, "I have fixed the syntax error; the game should now run.");
		expect(runs).toHaveLength(1);
		expect(runs[0]!.content).toContain("[verification_failed]");
		expect(runs[0]!.content).not.toContain("[success]");
		expect(procedural).toEqual([]);
		expect(reflected).toBe(0);
	});

	it("a delivery that passes is still a success, with its how-to and its post-mortem", async () => {
		const { runs, procedural, reflected } = await turn(FIXED, "The game runs.");
		expect(runs).toHaveLength(1);
		expect(runs[0]!.content).toContain("[success]");
		expect(procedural).toHaveLength(1);
		expect(reflected).toBe(1);
	});
});
