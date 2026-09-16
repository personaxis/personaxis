/**
 * E89: a service run leaves what it did in the persona's memory.
 *
 * Until this, only the terminal wrote session turns. A persona could work through a whole service, step after
 * step, and have nothing for the distillation to read: the memory that governs its next run was built from the
 * conversations a person happened to have with it, and never from the work.
 *
 * What is checked here is the bookkeeping, which is the part that can be checked without a model: which
 * sessions a run opens, what it writes into them, and that a disk that refuses never costs a step that already
 * did the work. What the closing itself distils is `closeSessionMemory`, and that is core's test.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { serviceSessions } from "../src/service-session.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pxs-e89-"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A persona on disk, which is all the seam needs: no model, no provider, no loop. */
function persona(at: string, name: string): string {
	const where = join(dir, at);
	mkdirSync(where, { recursive: true });
	const p = join(where, "personaxis.md");
	writeFileSync(p, `---\napiVersion: personaxis/v1\nkind: Persona\nname: ${name}\n---\n# ${name}\n`);
	return p;
}

function sessionFiles(personaPath: string): string[] {
	const at = join(dirname(personaPath), "sessions");
	return existsSync(at) ? readdirSync(at).filter((f) => f.endsWith(".jsonl")) : [];
}

/** Every row of every session of a persona, header included, in the order they were written. */
function rows(personaPath: string): Array<Record<string, unknown>> {
	const at = join(dirname(personaPath), "sessions");
	return sessionFiles(personaPath).flatMap((f) =>
		readFileSync(join(at, f), "utf-8")
			.split("\n")
			.filter((line) => line.trim() !== "")
			.map((line) => JSON.parse(line) as Record<string, unknown>),
	);
}

function step(personaPath: string, personaRef: string, prompt: string, answer: string): Parameters<ReturnType<typeof serviceSessions>["note"]>[0] {
	return { personaPath, personaRef, prompt, answer, frontmatter: {} };
}

describe("the sessions a service run keeps (E89)", () => {
	it("keeps one session for the whole run, and not one per step", () => {
		const p = persona("gamewright", "Gamewright");
		const sessions = serviceSessions();

		sessions.note(step(p, "gamewright", "design the loop", "designed it"));
		sessions.note(step(p, "gamewright", "balance the numbers", "balanced them"));
		sessions.note(step(p, "gamewright", "write it up", "wrote it up"));

		// Three steps of one service are three turns of the same working conversation, not three conversations.
		expect(sessionFiles(p)).toHaveLength(1);
		expect(rows(p).filter((r) => r.type === "turn")).toHaveLength(6);
	});

	it("gives a second persona its own session, because a step it ran is work it did", () => {
		// The defect this was written against: the first version wrote turns only for the persona that opened
		// the session, so the second persona of a service finished its step and remembered none of it.
		const one = persona("gamewright", "Gamewright");
		const two = persona("reviewer", "Reviewer");
		const sessions = serviceSessions();

		sessions.note(step(one, "gamewright", "design the loop", "designed it"));
		sessions.note(step(two, "reviewer", "review the design", "reviewed it"));

		expect(sessionFiles(one)).toHaveLength(1);
		expect(sessionFiles(two)).toHaveLength(1);
		expect(rows(two).filter((r) => r.type === "turn").map((r) => r.content)).toEqual(["review the design", "reviewed it"]);
	});

	it("writes the brief and the answer as `note`, never as something a person said", () => {
		const p = persona("gamewright", "Gamewright");
		const sessions = serviceSessions();

		sessions.note(step(p, "gamewright", "design the loop", "designed it"));

		const turns = rows(p).filter((r) => r.type === "turn");
		expect(turns.map((r) => r.role)).toEqual(["note", "note"]);
		expect(turns.map((r) => r.from)).toEqual(["gamewright", "gamewright"]);
		expect(rows(p)[0]).toMatchObject({ type: "header", kind: "background", persona: "gamewright" });
	});

	it("never costs a step the work it already did, when the disk refuses the session", () => {
		const p = persona("gamewright", "Gamewright");
		// A file where the sessions directory would go: writing is impossible and nothing can be done about it.
		writeFileSync(join(dirname(p), "sessions"), "not a directory");
		const sessions = serviceSessions();

		expect(() => sessions.note(step(p, "gamewright", "design the loop", "designed it"))).not.toThrow();
		expect(() => sessions.close()).not.toThrow();
	});

	it("closes every session it opened, and says what each close did", () => {
		// The first version of this test asserted that a later step opened a new session, which is true of a
		// close that did nothing at all: it measured the emptied map and not the closing. Naming what each
		// close reported is what a broken close actually fails.
		const one = persona("gamewright", "Gamewright");
		const two = persona("reviewer", "Reviewer");
		const sessions = serviceSessions();
		sessions.note(step(one, "gamewright", "design the loop", "designed it"));
		sessions.note(step(two, "reviewer", "review the design", "reviewed it"));

		const closed = sessions.close();

		expect(closed.map((c) => c.personaRef).sort()).toEqual(["gamewright", "reviewer"]);
		// A closed session is over: the next step of a later run opens its own instead of appending to it.
		sessions.note(step(one, "gamewright", "a later run", "later work"));
		expect(sessionFiles(one)).toHaveLength(2);
		expect(sessionFiles(two)).toHaveLength(1);
	});
});
