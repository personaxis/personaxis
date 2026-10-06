// What a daemon owes the work it was doing when it stopped.
//
// The gateway seals runs whose MACHINE went quiet. It cannot see this case: a
// daemon that restarts in ten seconds is not silent, so the alarm never fires and
// the run it was executing stays `running` in the workspace with nobody left who
// could ever end it.
//
// The file is read at startup before anything has checked it, so the parsing gets
// as much attention as the happy path: a corrupt one must not end runs that are
// alive, and it must not turn a `connect` into thousands of events.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	endingsFor,
	inFlightPath,
	MAX_CARRIED,
	parseInFlight,
	rememberInFlight,
	RESTART_MECHANISM,
	takeInFlight,
} from "../src/workspace/in-flight.js";

let home: string;
const io = { home: () => home };

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "in-flight-"));
});

afterEach(async () => {
	await rm(home, { recursive: true, force: true });
});

const job = (id: string) => ({ job_id: id, started_at: "2026-09-06T10:00:00.000Z" });

describe("remembering what is in flight", () => {
	it("comes back on the next start", async () => {
		rememberInFlight([job("job_1"), job("job_2")], io);

		expect(takeInFlight(io)).toEqual([job("job_1"), job("job_2")]);
	});

	it("forgets it in the same breath", () => {
		// Read once and removed. Leaving it would have a second restart report the
		// same run again, and an ending arriving twice is what the room's seal
		// exists to refuse: better not to send it.
		rememberInFlight([job("job_1")], io);

		expect(takeInFlight(io)).toHaveLength(1);
		expect(takeInFlight(io)).toEqual([]);
		expect(existsSync(inFlightPath(io))).toBe(false);
	});

	it("removes the file when the last job ends", () => {
		// The normal path, and the one that keeps a clean shutdown from reporting a
		// failure on the next start.
		rememberInFlight([job("job_1")], io);
		rememberInFlight([], io);

		expect(existsSync(inFlightPath(io))).toBe(false);
		expect(takeInFlight(io)).toEqual([]);
	});

	it("says nothing when there was no previous process", () => {
		expect(takeInFlight(io)).toEqual([]);
	});

	it("leaves nothing half written", async () => {
		rememberInFlight([job("job_1")], io);

		// Written beside and renamed over. A staging file left behind would be read
		// by nothing, but it is the evidence that the rename did not happen.
		expect(existsSync(`${inFlightPath(io)}.new`)).toBe(false);
		const raw = await readFile(inFlightPath(io), "utf8");
		expect(JSON.parse(raw)).toEqual([job("job_1")]);
	});
});

describe("a file this process did not write", () => {
	it("reads as nothing rather than as job ids", async () => {
		// Truncated, corrupt, or written by a version that shaped it differently.
		// Inventing ids from any of those would end runs that are alive.
		expect(parseInFlight("")).toEqual([]);
		expect(parseInFlight("{ not json")).toEqual([]);
		expect(parseInFlight('{"job_id":"job_1"}')).toEqual([]);
		expect(parseInFlight("[1, 2, 3]")).toEqual([]);
		expect(parseInFlight('[{"job_id":""}, {"job_id":"   "}, null]')).toEqual([]);
	});

	it("keeps an entry that lost its timestamp", () => {
		// The id is what an ending needs. A missing start time costs a sentence,
		// not a run left running forever.
		expect(parseInFlight('[{"job_id":"job_1"}]')).toEqual([{ job_id: "job_1", started_at: "" }]);
	});

	it("carries one entry per job", () => {
		expect(parseInFlight('[{"job_id":"a"},{"job_id":"a"}]')).toHaveLength(1);
	});

	it("stops at the ceiling", () => {
		const many = JSON.stringify(
			Array.from({ length: MAX_CARRIED + 10 }, (_, i) => ({ job_id: `job_${i}` })),
		);
		expect(parseInFlight(many)).toHaveLength(MAX_CARRIED);
	});

	it("survives a directory where the file should be", async () => {
		// Nothing about this is expected. It is here because the read happens at
		// startup, and a `connect` that throws on it is a machine that cannot come
		// back at all.
		await writeFile(join(home, "unrelated"), "x");
		expect(() => takeInFlight({ home: () => join(home, "unrelated") })).not.toThrow();
	});
});

describe("what the record is told", () => {
	const NOW = new Date("2026-09-06T12:00:00.000Z");

	it("ends the run and says the runtime did it", () => {
		const [ending] = endingsFor([job("job_1")], NOW);

		expect(ending).toMatchObject({
			job_id: "job_1",
			kind: "persona.session.ended",
			ts: NOW.toISOString(),
		});
		// The persona did not stop and did not fail. Its process was replaced
		// underneath it, and an ending attributed to the persona would put a
		// decision in the mouth of a worker that was not consulted.
		expect((ending as { author?: unknown }).author).toEqual({
			kind: "runtime",
			mechanism: RESTART_MECHANISM,
			reason: expect.stringContaining("restarted"),
		});
	});

	it("says failed and not orphaned", () => {
		// A distinction worth keeping. Orphaned is the machine being gone, and a
		// person reading it goes to check whether the computer is on. This machine
		// is on, answering, and running the daemon that is telling them.
		const [ending] = endingsFor([job("job_1")], NOW);

		expect((ending as { status?: string }).status).toBe("failed");
		expect((ending as { reason?: string }).reason).toContain("restarted");
	});

	it("has nothing to say when nothing was in flight", () => {
		expect(endingsFor([], NOW)).toEqual([]);
	});
});
