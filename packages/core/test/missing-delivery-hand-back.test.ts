/**
 * E135: a skill that DECLARES a delivery was loaded and the turn is closing with no file, so the close is handed back once.
 *
 * Measured on `build-game` (e132): the persona loaded `playable-prototype`, wrote the design into the chat and
 * closed, three runs in six. The first version read `allowed-tools` and broke `feel-numbers`: `game-feel` MAY write,
 * the request asked for advice, and the hand-back cost the answer its numbers. So the skill now declares what it
 * delivers in `metadata.personaxis.delivers`. These drive the real loop with a scripted model and skills on disk,
 * and read what the model was sent; the negative ones matter as much as the positive ones.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PersonaAgent, compile, DEFAULT_POLICY, type CompiledPolicy, type Policy } from "../src/index.js";
import { useSkillTool } from "../src/tools/use-skill.js";
import { localSkillsOf } from "../src/run/local-skills.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pxs-e135-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const policy = (): Policy => ({ ...DEFAULT_POLICY, workspaceRoot: dir, approval: "never", sandbox: "workspace-write" });
const capability = () =>
	compile({
		persona_version_id: "pv", hash: "h", compiled_at: new Date().toISOString(), ttl_seconds: 3600, deny: [], allow: [], hard_limits: [],
		prohibited_behaviors: [], egress_allowlist: [], sandbox: "workspace-write", approval: "never", gate_rules: [],
	} as CompiledPolicy);

const BROKEN = '<!doctype html>\n<script>\nconst s = {\n  x: 0\n  y: 1\n};\n</script>\n';
const FIXED = '<!doctype html>\n<canvas id="s"></canvas>\n<script>\nconst ctx = document.getElementById("s").getContext("2d");\nrequestAnimationFrame(function f() { ctx.fillRect(0, 0, 1, 1); requestAnimationFrame(f); });\n</script>\n';

/**
 * Two skills that may BOTH write files: one declares it delivers `game.html`, the other declares nothing, which is
 * exactly `game-feel`, the skill whose advice the first version turned into a hand-back.
 */
function persona(): string {
	const folder = join(dir, ".personaxis", "personas", "p");
	const tools = "read_file, write_file, edit_file, check_page, finish";
	const skills: Array<[string, string]> = [
		["playable-prototype", "metadata:\n  personaxis:\n    delivers: [game.html]\n"],
		["game-feel", ""],
	];
	for (const [name, extra] of skills) {
		mkdirSync(join(folder, "skills", name), { recursive: true });
		writeFileSync(join(folder, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}\nallowed-tools: ${tools}\n${extra}---\n# ${name}\nDo the thing.\n`);
	}
	const path = join(folder, "personaxis.md");
	writeFileSync(path, "---\nmetadata: { name: p, version: 1.0.0 }\nidentity: { canonical_id: p }\nextensions: { skills: [skills/playable-prototype, skills/game-feel] }\n---\nbody");
	return path;
}

type Step = { tool: string; args: object } | { text: string };
async function turn(steps: Step[]): Promise<{ handedBack: string[]; sent: number }> {
	const bodies: Array<Array<{ role: string; content: string }>> = [];
	let i = 0;
	const fetchImpl = (async (url: string, init?: { body?: string }) => {
		if (String(url).endsWith("/models")) return { ok: true, status: 200, json: async () => ({ data: [] }) };
		if (init?.body) bodies.push(JSON.parse(init.body).messages ?? []);
		const s = steps[Math.min(i, steps.length - 1)]!;
		i += 1;
		const message = "tool" in s
			? { content: "", tool_calls: [{ id: `c${i}`, type: "function", function: { name: s.tool, arguments: JSON.stringify(s.args) } }] }
			: { content: s.text };
		return { ok: true, status: 200, json: async () => ({ choices: [{ message }] }) };
	}) as unknown as typeof fetch;
	const personaPath = persona();
	// `use_skill` is contributed by `runnerFor`, not built in; lent here the way the product lends it.
	await new PersonaAgent({
		llm: { endpoint: "http://x/v1", model: "m", fetchImpl },
		policy: policy(),
		capability: capability(),
		personaPath,
		extraTools: [useSkillTool({ skills: () => localSkillsOf(personaPath).skills })],
	}).run("make me a small game");
	const last = bodies[bodies.length - 1] ?? [];
	const handedBack = last
		.filter((m) => m.role === "user" && typeof m.content === "string" && (m.content.includes("delivers a file") || m.content.includes("does not work")))
		.map((m) => m.content);
	return { handedBack, sent: bodies.length };
}

const USE = (name: string): Step => ({ tool: "use_skill", args: { name } });
const DESIGN_IN_CHAT: Step = { text: "Game Design Document: Cat Crossing the Road. What the game is: ..." };

describe("a skill that declares a delivery, loaded, and no file delivered is handed back once (E135)", () => {
	it("the build-game failure: loads playable-prototype, writes the design into the chat, is told so once", async () => {
		const { handedBack } = await turn([USE("playable-prototype"), DESIGN_IN_CHAT, DESIGN_IN_CHAT]);
		expect(handedBack).toHaveLength(1);
		expect(handedBack[0]).toContain("`playable-prototype` delivers game.html");
		expect(handedBack[0]).toContain("with your full answer");
	});

	it("and a persona that then writes the file closes with it", async () => {
		const { handedBack, sent } = await turn([
			USE("playable-prototype"),
			DESIGN_IN_CHAT,
			{ tool: "write_file", args: { path: "game.html", content: FIXED } },
			{ tool: "finish", args: { summary: "game.html is ready" } },
		]);
		expect(handedBack).toHaveLength(1);
		expect(sent).toBe(4);
	});
});

describe("and nothing else is (E135)", () => {
	it("a turn that delivered is not handed back", async () => {
		const { handedBack } = await turn([
			USE("playable-prototype"),
			{ tool: "write_file", args: { path: "game.html", content: FIXED } },
			{ tool: "finish", args: { summary: "done" } },
		]);
		expect(handedBack).toEqual([]);
	});

	it("a skill that may write but declares no delivery does not trigger it: the feel-numbers case", async () => {
		const { handedBack } = await turn([USE("game-feel"), { text: "Cut the rise time to 0.3 s and the fall gravity to 2x." }]);
		expect(handedBack).toEqual([]);
	});

	it("one hand-back per turn, shared with E106: a missing delivery, then a broken one, is handed back once", async () => {
		const { handedBack } = await turn([
			USE("playable-prototype"),
			DESIGN_IN_CHAT,
			{ tool: "write_file", args: { path: "game.html", content: BROKEN } },
			{ tool: "finish", args: { summary: "done" } },
		]);
		expect(handedBack).toHaveLength(1);
		expect(handedBack[0]).toContain("delivers a file");
	});
});
