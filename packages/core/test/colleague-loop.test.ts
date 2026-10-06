/**
 * E87 inside a real turn: work addressed to a colleague is done by that colleague, and only its answer comes back.
 *
 * The parent and the colleague talk to the same scripted model, told apart by what each one was SENT: the
 * colleague's own identity travels in its request, so "somebody else did it" is something this can see rather
 * than assume. Its working-out is real, and searched for in the parent's requests.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runnerFor } from "../src/run/runner-for.js";
import { DEFAULT_POLICY } from "../src/sandbox.js";

let dir: string;
let personaPath: string;

/** What only the colleague's own document says, so its request is recognisable. */
const PURPOSE = "checks every word of the contract";
/** What only the colleague's own transcript ever holds. */
const SCRATCH = "COLLEAGUE-SCRATCH-that-must-never-reach-the-asker";
const DONE = "the wording is fine, with two changes";

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pxs-e87-loop-"));
	personaPath = join(dir, ".personaxis", "personaxis.md");
	mkdirSync(join(dir, ".personaxis"), { recursive: true });
	writeFileSync(
		personaPath,
		"---\npermissions:\n  sandbox: workspace-write\n  approval: never\nidentity:\n  system_identity:\n    purpose: runs the shop\n---\n# Boss\n",
	);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function subPersona(address: string, purpose: string, permissions = "  sandbox: workspace-write\n  approval: never\n"): void {
	const folder = join(dir, ".personaxis", "personas", ...address.split("/").join("/personas/").split("/"));
	mkdirSync(folder, { recursive: true });
	// The purpose goes in the BODY and not only in the frontmatter, because the body is what reaches the model:
	// an uncompiled persona is described to itself by its spec body, and the frontmatter never gets there. The
	// first version of this fixture put it in the frontmatter, and the colleague's request was indistinguishable
	// from the asker's, which made the test blind to whether anybody else had run at all.
	writeFileSync(
		join(folder, "personaxis.md"),
		`---\npermissions:\n${permissions}identity:\n  system_identity:\n    purpose: ${purpose}\n---\n# ${address}\n\n${purpose}\n`,
	);
}

type Call = { name: string; args: Record<string, unknown> };
type Sent = Array<{ role: string; content?: unknown }>;

/** A model that answers the asker from a script and the colleague from another, telling them apart by what it was sent. */
function scripted(parent: readonly Call[]): { fetchImpl: typeof fetch; parentSent: Sent[]; colleagueSent: Sent[] } {
	const parentSent: Sent[] = [];
	const colleagueSent: Sent[] = [];
	let parentTurn = 0;
	let colleagueTurn = 0;

	const reply = (turn: number, call: Call) => ({
		ok: true,
		status: 200,
		json: async () => ({
			choices: [
				{
					message: { content: "", tool_calls: [{ id: `c${turn}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }] },
					finish_reason: "tool_calls",
				},
			],
		}),
	});

	const fetchImpl = (async (url: string, init?: { body?: string }) => {
		if (String(url).endsWith("/models")) return { ok: true, status: 200, json: async () => ({ data: [] }) };
		const messages = (JSON.parse(init?.body ?? "{}") as { messages?: Sent }).messages ?? [];
		const whole = messages.map((message) => String(message.content ?? "")).join("\n");

		// The colleague's own identity is in its request and in nobody else's.
		if (whole.includes(PURPOSE)) {
			colleagueSent.push(messages);
			colleagueTurn += 1;
			return colleagueTurn === 1
				? reply(colleagueTurn, { name: "write_file", args: { path: "review.md", content: `# review\n${SCRATCH}\n` } })
				: reply(colleagueTurn, { name: "finish", args: { summary: DONE } });
		}

		parentSent.push(messages);
		parentTurn += 1;
		return reply(parentTurn, parent[parentTurn - 1] ?? { name: "finish", args: { summary: "handed over and done" } });
	}) as unknown as typeof fetch;

	return { fetchImpl, parentSent, colleagueSent };
}

async function turn(script: readonly Call[]) {
	const model = scripted(script);
	const outcome = await runnerFor(
		{
			personaPath,
			frontmatter: { permissions: { sandbox: "workspace-write", approval: "never" } },
			llm: { endpoint: "http://x/v1", model: "m", fetchImpl: model.fetchImpl } as never,
		},
		{ policy: { ...DEFAULT_POLICY, workspaceRoot: dir, sandbox: "workspace-write", approval: "never" } },
	).run({ turn: "t1", prompt: "get the contract checked", asker: { kind: "human", id: "mara" } });

	return { outcome, parentSent: model.parentSent, colleagueSent: model.colleagueSent };
}

describe("work handed to a colleague (E87)", () => {
	it("is done by the colleague, under its own identity", async () => {
		subPersona("legal", PURPOSE);
		const { colleagueSent } = await turn([{ name: "delegate", args: { to: "legal", task: "check the wording of the contract" } }]);

		expect(colleagueSent.length).toBeGreaterThan(0);
		expect(colleagueSent[0]!.map((message) => String(message.content ?? "")).join("\n")).toContain("check the wording of the contract");
	});

	it("brings back the answer and not the colleague's working-out", async () => {
		subPersona("legal", PURPOSE);
		const { parentSent } = await turn([{ name: "delegate", args: { to: "legal", task: "check the wording" } }]);

		const afterwards = parentSent.at(-1)!.map((message) => String(message.content ?? "")).join("\n");
		expect(afterwards).toContain(DONE);
		expect(afterwards).not.toContain(SCRATCH);
	});

	it("refuses an address the map does not show, and names the ones it does", async () => {
		subPersona("legal", PURPOSE);
		const { parentSent, colleagueSent } = await turn([{ name: "delegate", args: { to: "finance", task: "check the numbers" } }]);

		const afterwards = parentSent.at(-1)!.map((message) => String(message.content ?? "")).join("\n");
		expect(afterwards).toContain("no colleague at finance");
		expect(afterwards).toContain("legal");
		// And nothing ran: a refusal that started an agent would be the opposite of a refusal.
		expect(colleagueSent).toEqual([]);
	});

	it("tells a persona with no colleagues that it has none, rather than resolving a folder", async () => {
		const { parentSent, colleagueSent } = await turn([{ name: "delegate", args: { to: "legal", task: "check the wording" } }]);

		expect(parentSent.at(-1)!.map((message) => String(message.content ?? "")).join("\n")).toContain("no colleagues to hand work to");
		expect(colleagueSent).toEqual([]);
	});

	it("still runs a sub-task of the same persona when no colleague is named", async () => {
		// The address is optional, and without it this is exactly what delegation always did.
		subPersona("legal", PURPOSE);
		const { colleagueSent } = await turn([{ name: "delegate", args: { task: "draft the summary" } }]);

		expect(colleagueSent).toEqual([]);
	});
});
