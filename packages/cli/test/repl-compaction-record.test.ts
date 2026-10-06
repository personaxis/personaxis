/**
 * The REPL's own compactions reach the record too.
 *
 * E25 connected the LOOP's compactions by handing the plan out through the seam, where
 * the runner writes it. That covers a compaction taken inside a turn, and this surface
 * takes two more outside one: the window filling between turns, and a person typing
 * `/compact`. Neither passes an observer, so neither was ever going to be written down,
 * and a persona whose engine records its compactions while the prompt a person actually
 * uses does not is a record that is true only about half the compactions.
 *
 * What is asserted here is the same shape the loop's entries have, on purpose. One
 * spelling of a compaction in one chain is the point; a second body would be the thing
 * `compactionEntry` exists to prevent.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compaction, record as recordApi } from "@personaxis/core";
import { recordReplCompaction, whyCompacted } from "../src/repl/compaction-record.js";

let dir: string;
let saved: string | undefined;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pxs-rc-"));
	saved = process.env.PERSONAXIS_HOME;
	process.env.PERSONAXIS_HOME = join(dir, "home");
});

afterEach(() => {
	if (saved === undefined) delete process.env.PERSONAXIS_HOME;
	else process.env.PERSONAXIS_HOME = saved;
});

/** A persona on disk, minimal enough that the record can be opened against it. */
function persona(): { personaPath: string; statePath: string } {
	const personaPath = join(dir, "personaxis.md");
	writeFileSync(personaPath, "---\nidentity: { canonical_id: t, display_name: T }\n---\n");
	return { personaPath, statePath: join(dir, "state.json") };
}

const plan = compaction.compactionPlan({
	kept: [{ role: "user", content: "recent" }],
	summarised: [{ role: "user", content: "old" }],
	before: 900,
	after: 300,
});

function entriesAt(personaPath: string) {
	return recordApi.readRecord(recordApi.recordPathFor(personaPath));
}

describe("why a compaction happened, in the words the record carries", () => {
	it("says the window filled, with the number", () => {
		expect(whyCompacted({ kind: "auto", pct: 0.87 })).toBe("the session window reached 87%");
	});

	it("says a person asked, without naming them as the one who did it", () => {
		// A person asking for a compaction did not perform one. The distinction is the
		// author invariant read from its least dramatic side.
		expect(whyCompacted({ kind: "asked" })).toBe("a person asked for it at the prompt");
	});
});

describe("a REPL compaction in the record", () => {
	it("lands with the runtime as its author and the reason it carries", async () => {
		const { personaPath, statePath } = persona();

		await recordReplCompaction(personaPath, statePath, { kind: "asked" }, plan, () => {
			throw new Error("should not have reported a problem");
		});

		const written = entriesAt(personaPath).filter((entry) => entry.body.type === "failure");
		expect(written).toHaveLength(1);
		expect(written[0]!.author).toEqual({
			kind: "runtime",
			mechanism: "compaction",
			reason: "a person asked for it at the prompt",
		});
	});

	it("says what was moved, in the same words the loop's entries use", async () => {
		const { personaPath, statePath } = persona();

		await recordReplCompaction(personaPath, statePath, { kind: "auto", pct: 0.9 }, plan, () => {});

		const body = entriesAt(personaPath).find((entry) => entry.body.type === "failure")!.body;
		expect(body).toEqual({
			type: "failure",
			code: "compaction",
			message: "the session window reached 90%: pruned 0, summarised 1, kept 1, 900 to 300",
			subject: "compaction",
		});
	});

	it("leaves a chain that still verifies", async () => {
		const { personaPath, statePath } = persona();

		await recordReplCompaction(personaPath, statePath, { kind: "asked" }, plan, () => {});
		await recordReplCompaction(personaPath, statePath, { kind: "auto", pct: 0.95 }, plan, () => {});

		const entries = entriesAt(personaPath);
		expect(entries.filter((entry) => entry.body.type === "failure")).toHaveLength(2);
		expect(recordApi.verify(entries).ok).toBe(true);
	});

	it("reports rather than throws when it cannot be written", async () => {
		// The person keeps the conversation they just compacted. Losing it because the
		// disk said no would be trading the thing that worked for the note about it, and
		// a compaction nobody was told about is the one failure a record cannot have.
		const problems: string[] = [];

		await recordReplCompaction(
			join(dir, "no", "such", "persona.md"),
			join(dir, "no", "such", "state.json"),
			{ kind: "asked" },
			plan,
			(problem) => problems.push(problem.message),
		);

		expect(problems).toHaveLength(1);
	});
});
