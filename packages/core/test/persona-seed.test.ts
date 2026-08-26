/**
 * What a persona is on the day it is created.
 *
 * Seeding used to write a `state.json` holding every declared coordinate at its
 * envelope mean and an empty `mutation_log`, which is a persona whose numbers appear
 * with nobody named. On the reference example that was eleven of twelve values with
 * no origin anybody could point at: a small hole in an ordinary log, and an
 * unacceptable one in a chain sold as proof, because "where did this number come
 * from" is the first question anybody asks and the honest answer was nowhere.
 *
 * The migration could reconstruct origins for a persona that already existed, and
 * reconstructing is not knowing. An untouched coordinate comes back as whatever it
 * holds now, so a spec whose declared mean changes later makes the reconstruction
 * report the new mean as where the coordinate started.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { extractEnvelopes } from "../src/envelopes.js";
import { ensureState, loadPersona, projectPersona, readState } from "../src/persona.js";
import { verify } from "../src/record/chain.js";
import { derive } from "../src/record/derive.js";
import { isGenesis } from "../src/record/entry.js";
import { readRecord, recordPathFor } from "../src/record/store.js";

const SPEC = [
	"---",
	"apiVersion: persona.dev/v1",
	"metadata: { name: seedling, version: 1.0.0 }",
	"identity: { canonical_id: seedling }",
	"personality:",
	"  traits:",
	"    openness: { mean: 0.7, range: [0.4, 0.9] }",
	"affect:",
	"  baseline:",
	"    mood:",
	"      tone: { mean: 0.1, range: [-1, 1] }",
	"---",
	"body",
	"",
].join("\n");

let dir: string;
let personaPath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pxs-seed-"));
	personaPath = join(dir, "personaxis.md");
	writeFileSync(personaPath, SPEC);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** The coordinates a persona's record accounts for the origin of. */
function accountedFor(path: string): string[] {
	return readRecord(recordPathFor(path))
		.filter(isGenesis)
		.map((entry) => (entry.body as { field: string }).field);
}

describe("a persona on the day it is created", () => {
	it("can account for every value it holds", () => {
		const state = ensureState(loadPersona(personaPath));
		const accounted = new Set(accountedFor(personaPath));

		expect(Object.keys(state.values).length).toBeGreaterThan(0);
		for (const field of Object.keys(state.values)) {
			expect({ field, accounted: accounted.has(field) }).toEqual({ field, accounted: true });
		}
	});

	it("starts at the position its spec declares, said by the record and not by the file", () => {
		// Compared against the envelopes rather than against hard-coded keys, because
		// which key shape a spec produces is a separate question from whether the record
		// knows where the coordinate started, and only the second one is being asked.
		const handle = loadPersona(personaPath);
		const envelopes = extractEnvelopes(handle.frontmatter).envelopes;
		ensureState(handle);

		const folded = derive(readRecord(recordPathFor(personaPath)));
		expect(folded.ok).toBe(true);
		if (!folded.ok) return;
		for (const [field, envelope] of Object.entries(envelopes)) {
			expect({ field, at: folded.state.values[field] }).toEqual({ field, at: envelope.mean });
		}
	});

	it("has an audit log with nothing in it, because nothing has happened yet", () => {
		// An origin is not a change. Printing origins into the log would make every
		// persona look as though it had been adjusted on the day it was created.
		expect(ensureState(loadPersona(personaPath)).mutation_log).toEqual([]);
	});

	it("writes a chain that verifies", () => {
		ensureState(loadPersona(personaPath));

		expect(verify(readRecord(recordPathFor(personaPath))).ok).toBe(true);
	});

	it("does not put a null where the schema declares a string", () => {
		// The seeded file used to be built by hand instead of printed, so it carried
		// `last_compiled_at: null` and `last_compiled_hash: null` while the published
		// schema declares both as strings. A brand new persona failed validation
		// against the spec this project ships.
		const handle = loadPersona(personaPath);
		const state = ensureState(handle);
		const onDisk = JSON.parse(readFileSync(handle.statePath, "utf8")) as Record<string, unknown>;

		expect("last_compiled_at" in state).toBe(false);
		expect("last_compiled_hash" in onDisk).toBe(false);
	});

	it("seeds once, and the second call reads what the first wrote", () => {
		const first = ensureState(loadPersona(personaPath));
		const before = readRecord(recordPathFor(personaPath)).length;

		const second = ensureState(loadPersona(personaPath));

		expect(second.values).toEqual(first.values);
		expect(readRecord(recordPathFor(personaPath))).toHaveLength(before);
	});

	it("reprints the file from the record when the file is gone but the record is not", () => {
		// `state init --force` deletes the file and asks for it again, and a persona whose
		// record exists is not a new persona whatever happened to its projection. Seeding
		// again would refuse, and allowing it would be worse: the origins are already
		// written and a second set would be a second history.
		const handle = loadPersona(personaPath);
		const first = ensureState(handle);
		const origins = readRecord(recordPathFor(personaPath)).length;
		rmSync(handle.statePath);

		const again = ensureState(loadPersona(personaPath));

		expect(again.values).toEqual(first.values);
		expect(readRecord(recordPathFor(personaPath))).toHaveLength(origins);
	});

	it("refuses to print from a record that does not verify, rather than printing anyway", () => {
		const handle = loadPersona(personaPath);
		ensureState(handle);
		const path = recordPathFor(personaPath);
		const entries = readRecord(path);
		const tampered = entries.map((e, i) => (i === 0 ? { ...e, hash: "0".repeat(64) } : e));
		writeFileSync(path, tampered.map((e) => JSON.stringify(e)).join("\n") + "\n");
		rmSync(handle.statePath);

		expect(() => ensureState(loadPersona(personaPath))).toThrow(/does not verify/);
	});

	it("does not raise a persona's declared schema version as a side effect of reprinting", () => {
		// Found by the check itself, on this repo's own persona: the file said 0.6.0 and
		// the projection wrote the build's current constant. Raising a schema version is
		// a migration, which `personaxis migrate` does deliberately and with a report,
		// and reprinting a view would have done it silently. The answer lived in two
		// places, one here and one in `adjust`, and they disagreed.
		const handle = loadPersona(personaPath);
		ensureState(handle);
		const entries = readRecord(recordPathFor(personaPath));
		const older = { ...readState(handle.statePath), schema_version: "0.6.0" };

		expect(projectPersona(handle, entries, older).schema_version).toBe("0.6.0");
		expect(projectPersona(handle, entries).schema_version).not.toBe("0.6.0");
	});

	it("gives two personas from the same spec the same origins, in the same order", () => {
		// Written in a fixed order, because object key order is not something to rest a
		// hash chain on: the same spec seeded twice must produce the same chain.
		const state = ensureState(loadPersona(personaPath));

		const elsewhere = join(dir, "elsewhere");
		mkdirSync(elsewhere, { recursive: true });
		const twin = join(elsewhere, "personaxis.md");
		writeFileSync(twin, SPEC);
		ensureState(loadPersona(twin));

		expect(accountedFor(twin)).toEqual(accountedFor(personaPath));
		expect(accountedFor(personaPath)).toEqual(Object.keys(state.values).sort());
	});
});
