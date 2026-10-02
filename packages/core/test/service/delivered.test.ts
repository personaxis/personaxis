/**
 * E163: a service the runtime starts in a turn begins after the opening steps whose files that turn already delivered.
 * Only opening steps, only persona steps with files and no approval, only when every file is there, and each one is
 * recorded as done with the reason, so the next step's handover says it.
 */
import { describe, expect, it } from "vitest";

import { runService, type ServiceDef, type ServicePorts } from "../../src/service/compose.js";

const GAME: ServiceDef = {
	address: "game-build",
	name: "Game build",
	steps: [
		{ position: 1, personaRef: "designer", instruction: "Design it.", produces: ["GAME.md"] },
		{ position: 2, personaRef: "builder", instruction: "Build it.", produces: ["game.html"] },
		{ position: 3, personaRef: "checker", instruction: "Check it.", produces: ["CHECK.md"] },
	],
};

/** Ports whose steps always complete, over a set of files that exist. */
function ports(existing: string[]) {
	const calls: string[] = [];
	const prompts: Record<string, string> = {};
	const files = new Set(existing);
	const p: ServicePorts = {
		resolveService: () => undefined,
		async runPersonaStep({ personaRef, prompt, position }) {
			calls.push(personaRef);
			prompts[personaRef] = prompt;
			const step = GAME.steps.find((s) => s.position === position);
			for (const f of step?.produces ?? []) files.add(f);
			return { outcome: "completed", summary: `${personaRef} done` };
		},
		async approve() {
			return "approved";
		},
		async checkProduced({ paths }) {
			return { produced: paths.filter((f) => files.has(f)).map((path) => ({ path, bytes: 1 })), missing: paths.filter((f) => !files.has(f)) };
		},
	};
	return { p, calls, prompts };
}

describe("a service that starts after what the turn already delivered (E163)", () => {
	it("records the opening step as already delivered, does not run it, and tells the next step", async () => {
		const { p, calls, prompts } = ports(["GAME.md"]);
		const r = await runService(GAME, p, { delivered: ["GAME.md"] });
		expect(r.status).toBe("completed");
		expect(calls).toEqual(["builder", "checker"]);
		expect(r.steps[0]).toMatchObject({ position: 1, outcome: "completed", reason: "already delivered in the same turn, before this run started" });
		expect(prompts.builder).toContain("GAME.md was already written in the same turn");
	});

	it("runs the opening step when the file it names is not there, whatever the turn said", async () => {
		const { p, calls } = ports([]);
		await runService(GAME, p, { delivered: ["GAME.md"] });
		expect(calls).toEqual(["designer", "builder", "checker"]);
	});

	it("never skips a step in the middle: a delivered later file alone changes nothing", async () => {
		const { p, calls } = ports(["game.html"]);
		await runService(GAME, p, { delivered: ["game.html"] });
		expect(calls).toEqual(["designer", "builder", "checker"]);
	});

	it("runs every step when nothing was delivered", async () => {
		const { p, calls } = ports(["GAME.md"]);
		await runService(GAME, p);
		expect(calls).toEqual(["designer", "builder", "checker"]);
	});
});
