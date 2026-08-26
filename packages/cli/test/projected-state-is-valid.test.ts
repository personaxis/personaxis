/**
 * Whether the state file we print is a file the spec we publish accepts.
 *
 * Written after it was not. `state.json` stopped being something the engine writes
 * and became something the record prints, and the printer narrowed the author with a
 * mapping of its own: `actor-llm` came back as `self`, `runtime-context` as
 * `runtime`. Neither word is in the schema's enum. Measured on a real persona, 147
 * of 147 rows failed validation, and a cast to `MutationLogEntry` was the only
 * reason the compiler said nothing.
 *
 * The lesson is not "check the actor". It is that a projection is only correct
 * against the format it claims to produce, and nothing was comparing the two. This
 * lives in the CLI because the CLI is where the engine and the schema meet: `core`
 * does not depend on `spec`, and it should not start depending on it so that a test
 * can be written closer to the code.
 *
 * The old writer failed it too, on a different field, which is the second reason to
 * check the whole document rather than the part that was just changed.
 */

import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { record, type StateFile } from "@personaxis/core";
import { stateSchema } from "@personaxis/spec";
import { describe, expect, it } from "vitest";

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validateState = ajv.compile(stateSchema) as ValidateFunction;

/** What failed, in words, so a failure names the field instead of a count. */
function complaints(validate: ValidateFunction): string[] {
	return (validate.errors ?? []).map(
		(e) => `${e.instancePath || "/"} ${e.message} ${JSON.stringify(e.params)}`,
	);
}

/** A stored file with one row per actor the schema declares. */
function stored(): StateFile {
	const actors = [
		"actor-llm",
		"runtime-decay",
		"runtime-context",
		"human-operator",
		"judge-correction",
	] as const;

	return {
		schema_version: "1.0.0",
		persona_id: "projected-state",
		persona_version: "1.0.0",
		session_id: "s-1",
		values: { "affect.baseline.mood.tone": 0.5 },
		mutation_log: actors.map((actor, i) => ({
			ts: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
			field: "affect.baseline.mood.tone",
			from: 0.4 + i * 0.02,
			to: 0.42 + i * 0.02,
			delta_requested: 0.02,
			clamped: false,
			reason: `moved by ${actor}`,
			actor,
		})),
	} as StateFile;
}

/** Migrate a stored file into a record and print it back. */
function projected(state: StateFile): StateFile {
	const entries = record.replayStateFile(state);
	const derived = record.derive(entries);
	if (!derived.ok) throw new Error(`the replay does not verify: ${derived.problem.kind}`);

	return record.project(derived.state, entries, {
		schemaVersion: state.schema_version,
		personaId: state.persona_id,
		personaVersion: state.persona_version,
		...(state.session_id === undefined ? {} : { sessionId: state.session_id }),
	});
}

describe("the file the record prints", () => {
	it("validates against the published state schema", () => {
		const ok = validateState(projected(stored()));

		expect(complaints(validateState)).toEqual([]);
		expect(ok).toBe(true);
	});

	it("names each actor with the word the schema declares for it", () => {
		// The narrower assertion, kept beside the schema one because a schema failure
		// says "not in the enum" and this says which word turned into which.
		const before = stored();
		const after = projected(before);

		expect(after.mutation_log.map((m) => m.actor)).toEqual(
			before.mutation_log.map((m) => m.actor),
		);
	});

	it("stays valid when the record holds a coordinate that never moved", () => {
		// A genesis entry is a value entry with no change, and printing one into the
		// log would put a mutation on every persona's first day. It is skipped, and
		// the file has to remain a valid file with the skip in place.
		const before = stored();
		before.values["personality.traits.openness"] = 0.7;

		const after = projected(before);

		expect(after.values["personality.traits.openness"]).toBe(0.7);
		expect(validateState(after)).toBe(true);
	});
});
