/**
 * E97: what `service resume` reads before anything runs, the flags it was given and the journal it was pointed
 * at. Picking a run up is the engine's (`service.resumeService`, tested in core); this is what the command
 * refuses on its own.
 */
import { describe, expect, it } from "vitest";

import { replyFrom, resumable } from "../src/commands/service.js";

const waitingRun = {
	service: "game-build",
	started: "2026-09-15T12:00:00.000Z",
	wallMs: 1000,
	brief: null,
	result: { status: "waiting", reason: "waiting for an answer", summary: null, summaryFrom: null, steps: [] },
	costs: [],
	total: {},
};

describe("the flags of service resume (E97)", () => {
	it("reads an answer, an approval and a refusal with or without its reason", () => {
		expect(replyFrom({ answer: "Mia" })).toEqual({ kind: "answer", answer: "Mia" });
		expect(replyFrom({ approve: true })).toEqual({ kind: "approval", approved: true });
		expect(replyFrom({ reject: "not this landlord" })).toEqual({ kind: "approval", approved: false, reason: "not this landlord" });
		expect(replyFrom({ reject: true })).toEqual({ kind: "approval", approved: false, reason: null });
	});

	it("refuses none of them, and more than one", () => {
		expect(replyFrom({})).toBe("give exactly one of --answer, --approve or --reject");
		expect(replyFrom({ answer: "Mia", approve: true })).toBe("give exactly one of --answer, --approve or --reject");
		expect(replyFrom({ approve: true, reject: true })).toBe("give exactly one of --answer, --approve or --reject");
	});
});

describe("the journal service resume is pointed at (E97)", () => {
	it("takes a waiting run", () => {
		expect(resumable(waitingRun).ok).toBe(true);
	});

	it("refuses a run already picked up, naming the run that continued it", () => {
		expect(resumable({ ...waitingRun, resumedBy: "runs/game-build-2.json" })).toEqual({
			ok: false,
			why: "this run was already picked up, and the run that continued it is runs/game-build-2.json",
		});
	});

	it("refuses a run that does not wait, and a file that is not a journal", () => {
		expect(resumable({ ...waitingRun, result: { ...waitingRun.result, status: "completed" } })).toEqual({
			ok: false,
			why: "only a waiting run is picked up, and this one is completed",
		});
		expect(resumable({ hello: "world" }).ok).toBe(false);
		expect(resumable(null).ok).toBe(false);
	});
});
