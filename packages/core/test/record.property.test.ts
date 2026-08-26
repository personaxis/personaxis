/**
 * The record's properties, plus the equivalence run against personas that exist.
 *
 * Two things are being protected here and they need different instruments.
 *
 * **Tamper evidence** is a claim about every possible edit, not about the three a
 * person thought of, so it is checked over generated chains and generated edits. An
 * example test proves you cannot make the one change you already knew about.
 *
 * **Equivalence** is a claim about the personas we actually have. Generated logs
 * exercise the shape; a real persona exercises the history, including whatever
 * happened to it over a hundred and forty-five mutations that nobody designed. The
 * old stored copy is not retired until this holds on those.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
	Journal,
	compareToStored,
	derive,
	replayStateFile,
	verify,
	type Author,
	type RecordEntry,
	decide,
} from "../src/record/index.js";
import type { Envelope } from "../src/envelopes.js";
import type { StateFile } from "../src/persona.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");

/**
 * Writes a row in the format `state.json` used before the record existed.
 *
 * The old engine used to be the convenient way to produce one, and it is gone. That
 * makes this better rather than worse: a migration is read by files written by
 * versions nobody has any more, so a test that could only build one by running the
 * writer was testing the writer as much as the migration. The arithmetic is `decide`,
 * because the clamp did not change when the thing that recorded it did.
 */
function legacy(
	state: StateFile,
	envelopes: Record<string, Envelope>,
	step: { field: string; delta: number; reason: string; actor?: string; blocked?: boolean },
): void {
	const envelope = envelopes[step.field]!;
	const from = state.values[step.field] ?? envelope.mean;
	const decision = decide(from, envelope, {
		field: step.field,
		delta: step.delta,
		reason: step.reason,
		...(step.blocked ? { blocked: true } : {}),
	});
	state.values[step.field] = decision.to;
	(state.mutation_log ??= []).push({
		ts: new Date(Date.UTC(2026, 0, 1) + state.mutation_log.length * 1000).toISOString(),
		field: step.field,
		from: decision.from,
		to: decision.to,
		delta_requested: step.delta,
		clamped: decision.clamped,
		reason: step.reason,
		actor: (step.actor ?? "actor-llm") as never,
		governance_blocked: decision.blocked,
	});
}

const authors = fc.oneof(
	fc.record({ kind: fc.constant("human" as const), id: fc.constantFrom("david", "ana") }),
	fc.record({ kind: fc.constant("persona" as const), id: fc.constantFrom("clio", "cmo") }),
	fc.record({ kind: fc.constant("component" as const), name: fc.constantFrom("loop", "gate") }),
	fc.record({
		kind: fc.constant("runtime" as const),
		mechanism: fc.constantFrom("kernel", "compaction"),
		reason: fc.constantFrom("a reason", "another reason"),
	}),
) as fc.Arbitrary<Author>;

const fields = fc.constantFrom("mood.tone", "traits.humour", "affect.valence");

/** A journal built from generated appends, with fixed timestamps. */
function chainOf(steps: readonly { author: Author; field: string; to: number }[]): RecordEntry[] {
	let tick = 0;
	const journal = new Journal({ now: () => new Date(Date.UTC(2026, 7, 22, 0, 0, tick++)) });
	for (const step of steps) {
		journal.append(step.author, {
			type: "value",
			field: step.field,
			from: 0,
			to: step.to,
			requested: step.to,
			clamped: false,
			blocked: false,
			reason: "generated",
		});
	}
	return journal.all() as RecordEntry[];
}

const chains = fc
	.array(
		fc.record({
			author: authors,
			field: fields,
			to: fc.double({ min: -1, max: 1, noNaN: true }),
		}),
		{ minLength: 1, maxLength: 12 },
	)
	.map(chainOf);

describe("no edit survives verification", () => {
	it("holds for a chain nobody touched", () => {
		fc.assert(
			fc.property(chains, (entries) => {
				expect(verify(entries).ok).toBe(true);
			}),
			{ numRuns: 300 },
		);
	});

	it("catches a changed value anywhere in the chain", () => {
		fc.assert(
			fc.property(chains, fc.nat(), fc.double({ min: -1, max: 1, noNaN: true }), (entries, at, to) => {
				const index = at % entries.length;
				const target = entries[index]!;
				const body = target.body as { to: number };
				fc.pre(body.to !== to);
				const forged = [...entries];
				forged[index] = { ...target, body: { ...target.body, to } as never };

				expect(verify(forged).ok).toBe(false);
			}),
			{ numRuns: 300 },
		);
	});

	it("catches an author moved onto somebody else", () => {
		fc.assert(
			fc.property(chains, fc.nat(), authors, (entries, at, author) => {
				const index = at % entries.length;
				const target = entries[index]!;
				fc.pre(JSON.stringify(target.author) !== JSON.stringify(author));
				const forged = [...entries];
				forged[index] = { ...target, author };

				expect(verify(forged).ok).toBe(false);
			}),
			{ numRuns: 300 },
		);
	});

	it("catches a deletion anywhere but the very end", () => {
		fc.assert(
			fc.property(chains, fc.nat(), (entries, at) => {
				fc.pre(entries.length > 1);
				const index = at % (entries.length - 1);
				const forged = entries.filter((_, position) => position !== index);

				expect(verify(forged).ok).toBe(false);
			}),
			{ numRuns: 300 },
		);
	});

	it("catches any reordering of two entries", () => {
		fc.assert(
			fc.property(chains, fc.nat(), fc.nat(), (entries, left, right) => {
				fc.pre(entries.length > 1);
				const a = left % entries.length;
				const b = right % entries.length;
				fc.pre(a !== b);
				const forged = [...entries];
				[forged[a], forged[b]] = [forged[b]!, forged[a]!];

				expect(verify(forged).ok).toBe(false);
			}),
			{ numRuns: 300 },
		);
	});

	it("catches an entry spliced in from another chain", () => {
		fc.assert(
			fc.property(chains, chains, fc.nat(), (entries, other, at) => {
				fc.pre(other.length > 0);
				// A chain of one entry is evidence of its own integrity and of nothing
				// else, because tamper evidence comes from entries linking to each other
				// and there is nothing to link to. Replacing the only entry with another
				// valid one therefore verifies, correctly. Worth knowing rather than
				// worth hiding: a record with one entry proves nothing about history.
				fc.pre(entries.length > 1);
				const index = at % entries.length;
				const spliced = other[0]!;
				// And splicing in an entry byte-identical to the one already there is not
				// an edit at all, so it is correctly undetectable.
				fc.pre(JSON.stringify(spliced) !== JSON.stringify(entries[index]!));
				const forged = [...entries];
				forged[index] = spliced;

				expect(verify(forged).ok).toBe(false);
			}),
			{ numRuns: 300 },
		);
	});
});

describe("deriving is a fold and folds the same way twice", () => {
	it("gives the same state however many times it runs", () => {
		fc.assert(
			fc.property(chains, (entries) => {
				const first = derive(entries);
				const second = derive(entries);
				expect(JSON.stringify(second)).toBe(JSON.stringify(first));
			}),
			{ numRuns: 300 },
		);
	});

	it("gives every field the value of its last entry", () => {
		fc.assert(
			fc.property(chains, (entries) => {
				const result = derive(entries);
				expect(result.ok).toBe(true);
				if (!result.ok) return;
				const expected: Record<string, number> = {};
				for (const entry of entries) {
					if (entry.body.type === "value") expected[entry.body.field] = entry.body.to;
				}
				expect(result.state.values).toEqual(expected);
			}),
			{ numRuns: 300 },
		);
	});

	it("never reports a state for a chain that does not verify", () => {
		fc.assert(
			fc.property(chains, fc.nat(), (entries, at) => {
				const index = at % entries.length;
				const forged = [...entries];
				forged[index] = { ...forged[index]!, hash: "tampered" };

				expect(derive(forged).ok).toBe(false);
			}),
			{ numRuns: 300 },
		);
	});
});

describe("the derived state equals the stored copy", () => {
	const envelopes: Record<string, Envelope> = {
		"mood.tone": { mean: 0, min: -0.4, max: 0.4, range: 0.4 } as Envelope,
		"traits.humour": { mean: 0.5, min: 0.2, max: 0.8, range: 0.3 } as Envelope,
		"affect.valence": { mean: 0.1, min: -0.5, max: 0.6, range: 0.55 } as Envelope,
	};

	it("holds over generated runs of mutations, clamps and refusals included", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						field: fc.constantFrom(...Object.keys(envelopes)),
						delta: fc.double({ min: -3, max: 3, noNaN: true }),
						blocked: fc.boolean(),
						actor: fc.constantFrom(
							"actor-llm" as const,
							"runtime-decay" as const,
							"human-operator" as const,
						),
					}),
					{ maxLength: 30 },
				),
				(steps) => {
					const state: StateFile = {
						schema_version: "1.1.0",
						persona_id: "generated",
						persona_version: "1.0.0",
						// Initialised at the declared means, which is what the real files do.
						values: Object.fromEntries(
							Object.entries(envelopes).map(([field, envelope]) => [field, envelope.mean]),
						),
						mutation_log: [],
					};
					for (const step of steps) {
						legacy(state, envelopes, {
							field: step.field,
							delta: step.delta,
							reason: "generated",
							actor: step.actor,
							blocked: step.blocked,
						});
					}

					const report = compareToStored(state);
					expect(report.mismatches).toEqual([]);
				},
			),
			{ numRuns: 200 },
		);
	});

	it("holds on the personas that exist, which is the check that matters", () => {
		// Generated logs exercise the shape. A real one exercises the history, which
		// nobody designed. These are read where they live and skipped when a checkout
		// does not have them, because a gate that fails for everyone without the
		// sibling repository is a gate somebody removes.
		const candidates = [
			join(REPO, ".personaxis", "state.json"),
			join(REPO, "..", "persona.md", ".personaxis", "personas", "cmo", "state.json"),
			join(REPO, "..", "persona.md", ".personaxis", "personas", "frontend-expert", "state.json"),
		].filter((path) => existsSync(path));

		if (candidates.length === 0) {
			expect(candidates).toEqual([]);
			return;
		}

		for (const path of candidates) {
			const state = JSON.parse(readFileSync(path, "utf8")) as StateFile;
			const replayed = replayStateFile(state);

			expect(verify(replayed).ok).toBe(true);
			const report = compareToStored(state);
			expect({ path, mismatches: report.mismatches }).toEqual({ path, mismatches: [] });
		}
	});
});
