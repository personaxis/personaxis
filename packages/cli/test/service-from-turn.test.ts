/**
 * E73: what a persona is told when a service it started from a turn ends. The run itself is the engine's
 * (`service.runService`, tested in core); this is the sentence the persona has to answer the person with.
 */
import { describe, expect, it } from "vitest";

import { describeRun } from "../src/commands/service.js";

const JOURNAL = "/work/.personaxis/services/runs/game-build-2026-09-15T12-00-00-000Z.json";

const step = (over: Record<string, unknown> = {}) => ({
	path: ["game-build"],
	serviceName: "Game build",
	position: 1,
	who: { persona: "gamewright" },
	outcome: "completed" as const,
	summary: null,
	reason: null,
	...over,
});

describe("what the persona is told about a run it started (E73)", () => {
	it("says how it ended, what the steps wrote and the last note", () => {
		const said = describeRun(
			"game-build",
			{
				status: "completed",
				reason: null,
				summary: "The game is in game.html; the document is in GAME.md.",
				summaryFrom: { path: ["game-build"], position: 2 },
				steps: [step({ produced: [{ path: "GAME.md", bytes: 1200 }] }), step({ position: 2, produced: [{ path: "game.html", bytes: 5800 }] })],
			},
			JOURNAL,
		);
		expect(said).toContain("game-build completed");
		expect(said).toContain("the steps wrote GAME.md (1200 bytes), game.html (5800 bytes)");
		expect(said).toContain("the last note: The game is in game.html");
		expect(said).toContain(`journal: ${JOURNAL}`);
	});

	it("names the step that failed and why, so the persona can say what went wrong", () => {
		const said = describeRun(
			"game-build",
			{
				status: "failed",
				reason: "step 2 failed",
				summary: null,
				summaryFrom: null,
				steps: [step(), step({ position: 2, outcome: "failed", reason: "step 2 was to write game.html, and did not" })],
			},
			JOURNAL,
		);
		expect(said).toContain("step 2 of Game build failed: step 2 was to write game.html, and did not");
	});

	it("says how a waiting run is picked up, in the words somebody would type", () => {
		const said = describeRun(
			"game-build",
			{
				status: "waiting",
				reason: "waiting for an answer: What is her name?",
				summary: null,
				summaryFrom: null,
				steps: [step()],
				waiting: { kind: "answer", path: ["game-build"], through: [], position: 1, since: 0, question: null },
			},
			JOURNAL,
		);
		expect(said).toContain("it is waiting; it is picked up with personaxis service resume");
		expect(said).toContain("--answer");
	});
});
