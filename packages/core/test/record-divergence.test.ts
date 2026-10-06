/**
 * Whether the state file still says what the record says.
 *
 * This is the check `state rebuild` became. It used to replay the `mutation_log`
 * inside `state.json` over the envelope means and compare the answer with the
 * `values` in the same file: one document checked against itself, which catches a
 * hand-edited number and nothing else, and which cannot notice that the log itself
 * was edited because it is what the comparison trusts.
 *
 * The record is the history now, so the question is whether the file agrees with it.
 * That covers the whole document rather than one field of it, and it is the thing
 * that makes editing `state.json` by hand change nothing that survives.
 *
 * Deliberately not `compareToStored`, which reads almost the same in English and asks
 * the other question: that one is a file against itself, and it is what proved the
 * migration.
 */

import { describe, expect, it } from "vitest";

import type { StateFile } from "../src/persona.js";
import { divergence } from "../src/record/project.js";

function file(values: Record<string, number>, extra: Partial<StateFile> = {}): StateFile {
	return {
		schema_version: "1.1.0",
		persona_id: "t",
		persona_version: "1.0.0",
		values,
		mutation_log: [],
		...extra,
	} as StateFile;
}

describe("a state file against the record's projection", () => {
	it("says nothing when they agree", () => {
		const recorded = file({ "mood.tone": 0.2 });

		expect(divergence(recorded, file({ "mood.tone": 0.2 }))).toEqual({
			values: [],
			differs: false,
		});
	});

	it("names the coordinate, with both numbers, when one was edited by hand", () => {
		const recorded = file({ "mood.tone": 0.2, "traits.openness": 0.7 });

		const { values, differs } = divergence(recorded, file({ "mood.tone": 0.9, "traits.openness": 0.7 }));

		expect(differs).toBe(true);
		expect(values).toEqual([{ field: "mood.tone", stored: 0.9, recorded: 0.2 }]);
	});

	it("reports a coordinate the file does not have at all", () => {
		// A file written before the coordinate was declared, or one somebody trimmed.
		// `undefined` rather than a zero, because "not there" and "there and nought"
		// are different situations and only one of them is a value.
		const recorded = file({ "mood.tone": 0.2 });

		expect(divergence(recorded, file({})).values).toEqual([
			{ field: "mood.tone", stored: undefined, recorded: 0.2 },
		]);
	});

	it("differs from a file that is not there, so a deleted one is repaired and not special-cased", () => {
		const { differs, values } = divergence(file({ "mood.tone": 0.2 }), undefined);

		expect(differs).toBe(true);
		expect(values).toEqual([{ field: "mood.tone", stored: undefined, recorded: 0.2 }]);
	});

	it("notices a difference outside the values, where no coordinate disagrees", () => {
		// A log the file lost is a file that no longer says what the record says, even
		// though every number in it is right. Reporting only the coordinates would call
		// that file healthy and leave the audit trail short.
		const recorded = file({ "mood.tone": 0.2 }, {
			mutation_log: [{ ts: "2026-08-01T00:00:00.000Z", field: "mood.tone", from: 0, to: 0.2,
				delta_requested: 0.2, clamped: false, reason: "a", actor: "actor-llm" }] as never,
		});

		const { values, differs } = divergence(recorded, file({ "mood.tone": 0.2 }));

		expect(values).toEqual([]);
		expect(differs).toBe(true);
	});
});
