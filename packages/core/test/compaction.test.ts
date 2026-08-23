/**
 * What compaction promises, and the property that is the whole reason for it.
 *
 * The property is in the second group: **no budget, however small, compacts a declared
 * layer**. Everything else is the reference's algorithm, which is good, kept honest.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
	compactionAuthor,
	compactionEntry,
	driftAcross,
	plan,
	summaryAcceptable,
	type Envelope,
	type Unit,
} from "../src/compaction/index.js";

const envelope: Envelope = {
	protectedLayers: ["identity", "character", "self_regulation"],
	protectedCeiling: 100,
};

const unit = (over: Partial<Unit> & { id: string }): Unit => ({
	weight: 10,
	prunable: false,
	...over,
});

describe("nothing happens when there is no pressure", () => {
	it("says so rather than returning a plan that changes nothing", () => {
		// A no-op plan is what left the reference's gate still saying compaction was
		// needed, so every later turn fired another one.
		const result = plan([unit({ id: "a" })], envelope, { weight: 10, threshold: 100 });

		expect(result).toEqual({ ok: false, why: "no_pressure" });
	});
});

describe("what is protected is read from the declared layers", () => {
	it("never prunes or summarises a protected unit", () => {
		const units = [
			unit({ id: "who", layer: "identity", weight: 30 }),
			unit({ id: "limits", layer: "self_regulation", weight: 30 }),
			unit({ id: "chat1", layer: "conversation", weight: 40, prunable: true }),
			unit({ id: "chat2", layer: "conversation", weight: 40, prunable: true }),
		];

		const result = plan(units, envelope, { weight: 140, threshold: 60 });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.plan.pruned).not.toContain("who");
		expect(result.plan.summarised).not.toContain("limits");
	});

	it("protects a nested layer by its prefix, so a sub-layer is covered", () => {
		const units = [
			unit({ id: "virtue", layer: "character.virtues.honesty", weight: 60 }),
			unit({ id: "chat", layer: "conversation", weight: 60, prunable: true }),
		];

		const result = plan(units, envelope, { weight: 120, threshold: 60 });

		expect(result.ok && result.plan.pruned).toEqual(["chat"]);
	});

	it("does not protect a unit that belongs to no layer at all", () => {
		const units = [
			unit({ id: "loose", weight: 60, prunable: true }),
			unit({ id: "who", layer: "identity", weight: 30 }),
		];

		const result = plan(units, envelope, { weight: 90, threshold: 40 });

		expect(result.ok && result.plan.pruned).toEqual(["loose"]);
	});
});

describe("protected says what survives, never how much", () => {
	it("reports an oversized protected region as an anomaly rather than trimming it", () => {
		// Their warning from the other side: turn boundaries do not protect old steps
		// inside a runaway turn. Protecting by layer would open the same trap if the
		// protected region could grow with nothing allowed to look at it.
		const units = [
			unit({ id: "who", layer: "identity", weight: 200 }),
			unit({ id: "chat", layer: "conversation", weight: 400, prunable: true }),
		];

		const result = plan(units, envelope, { weight: 600, threshold: 300 });

		expect(result.ok && result.plan.anomaly).toEqual({
			kind: "protected_over_ceiling",
			weight: 200,
			ceiling: 100,
		});
	});

	it("still reports the anomaly when it is the reason nothing can be compacted", () => {
		// The case where it matters most. An "incompressible" answer with no anomaly
		// sends the reader looking at the conversation when the conversation is not the
		// problem.
		const units = [
			unit({ id: "who", layer: "identity", weight: 500 }),
			unit({ id: "chat", layer: "conversation", weight: 50, prunable: true }),
		];

		const result = plan(units, envelope, { weight: 550, threshold: 300 });

		expect(result.ok).toBe(false);
		expect(!result.ok && result.why === "incompressible" && result.anomaly).toEqual({
			kind: "protected_over_ceiling",
			weight: 500,
			ceiling: 100,
		});
	});

	it("still refuses to compact it, anomaly or not", () => {
		const units = [unit({ id: "who", layer: "identity", weight: 500 })];

		const result = plan(units, envelope, { weight: 500, threshold: 100 });

		expect(result.ok).toBe(false);
		expect(!result.ok && result.why).toBe("incompressible");
	});
});

describe("prune before paying for a summary", () => {
	it("stops at pruning when pruning was enough", () => {
		const units = [
			unit({ id: "dump", layer: "conversation", weight: 80, prunable: true }),
			unit({ id: "text", layer: "conversation", weight: 20 }),
		];

		const result = plan(units, envelope, { weight: 100, threshold: 30 });

		expect(result.ok && result.plan.pruned).toEqual(["dump"]);
		expect(result.ok && result.plan.summarised).toEqual([]);
	});

	it("prunes only as much as it takes, not everything prunable", () => {
		const units = [
			unit({ id: "a", layer: "conversation", weight: 40, prunable: true }),
			unit({ id: "b", layer: "conversation", weight: 40, prunable: true }),
			unit({ id: "c", layer: "conversation", weight: 40, prunable: true }),
		];

		const result = plan(units, envelope, { weight: 120, threshold: 90 });

		expect(result.ok && result.plan.pruned).toEqual(["a"]);
	});

	it("summarises the middle only when pruning did not get there", () => {
		const units = Array.from({ length: 8 }, (_, index) =>
			unit({ id: `m${index}`, layer: "conversation", weight: 20 }),
		);

		const result = plan(units, envelope, { weight: 160, threshold: 60 }, { tailWeight: 40 });

		expect(result.ok && result.plan.summarised.length).toBeGreaterThan(0);
		// The tail survives, by weight rather than by count.
		expect(result.ok && result.plan.kept).toContain("m7");
	});
});

describe("a pair is never split", () => {
	it("keeps the other half of a pair whose partner is in the tail", () => {
		// Compacting half of a call and its result leaves a request with no answer,
		// which a provider rejects and which reads as data loss to everyone else.
		const units = [
			unit({ id: "old", layer: "conversation", weight: 40 }),
			unit({ id: "call", layer: "conversation", weight: 10, pairId: "p1" }),
			unit({ id: "result", layer: "conversation", weight: 10, pairId: "p1" }),
		];

		const result = plan(units, envelope, { weight: 60, threshold: 30 }, { tailWeight: 15 });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const split =
			result.plan.summarised.includes("call") !== result.plan.summarised.includes("result");
		expect(split).toBe(false);
	});
});

describe("a summary that does not shrink its source is refused", () => {
	it("accepts one that shrank and refuses one that did not", () => {
		// The case nobody predicts: a compaction that took a transcript from 379K to
		// 687K tokens, because the summary plus the reasoning it kept outweighed what it
		// replaced.
		expect(summaryAcceptable(1000, 100)).toBe(true);
		expect(summaryAcceptable(1000, 1000)).toBe(false);
		expect(summaryAcceptable(1000, 1200)).toBe(false);
	});
});

describe("no budget compacts a declared layer", () => {
	it("holds for any set of units and any threshold at all", () => {
		// This is the property the whole phase exists for. An agent that compresses
		// itself until it forgets who it is explains a large part of the drift the
		// industry measures and cannot correct.
		const units = fc.array(
			fc.record({
				id: fc.string({ minLength: 1, maxLength: 4 }),
				layer: fc.constantFrom(
					"identity",
					"character.virtues.honesty",
					"self_regulation",
					"conversation",
					"memory",
				),
				weight: fc.integer({ min: 1, max: 100 }),
				prunable: fc.boolean(),
			}),
			{ minLength: 1, maxLength: 20 },
		);

		fc.assert(
			fc.property(units, fc.integer({ min: 0, max: 200 }), (list, threshold) => {
				const unique = list.map((entry, index) => ({ ...entry, id: `${entry.id}-${index}` }));
				const total = unique.reduce((sum, entry) => sum + entry.weight, 0);

				const result = plan(unique, envelope, { weight: total, threshold });
				if (!result.ok) return;

				const touched = new Set([...result.plan.pruned, ...result.plan.summarised]);
				for (const entry of unique) {
					const guarded = envelope.protectedLayers.some(
						(layer) => entry.layer === layer || entry.layer.startsWith(`${layer}.`),
					);
					if (guarded) expect(touched.has(entry.id)).toBe(false);
				}
			}),
			{ numRuns: 500 },
		);
	});

	it("never reports an after weight above the before weight", () => {
		const units = fc.array(
			fc.record({
				id: fc.string({ minLength: 1, maxLength: 4 }),
				layer: fc.constantFrom("conversation", "memory"),
				weight: fc.integer({ min: 1, max: 50 }),
				prunable: fc.boolean(),
			}),
			{ minLength: 1, maxLength: 15 },
		);

		fc.assert(
			fc.property(units, fc.integer({ min: 0, max: 100 }), (list, threshold) => {
				const unique = list.map((entry, index) => ({ ...entry, id: `${entry.id}-${index}` }));
				const total = unique.reduce((sum, entry) => sum + entry.weight, 0);

				const result = plan(unique, envelope, { weight: total, threshold });
				if (!result.ok) return;

				expect(result.plan.after).toBeLessThanOrEqual(result.plan.before);
			}),
			{ numRuns: 500 },
		);
	});
});

describe("a compaction is written down, not performed on the record", () => {
	it("carries its author, which is the runtime and says why", () => {
		expect(compactionAuthor("context pressure at 82 percent")).toMatchObject({
			kind: "runtime",
			mechanism: "compaction",
		});
	});

	it("says what it decided, in numbers somebody can check afterwards", () => {
		const body = compactionEntry(
			{ kept: ["a"], pruned: ["b", "c"], summarised: ["d"], before: 400, after: 150 },
			"context pressure",
		);

		expect(body.type).toBe("failure");
		expect(body.type === "failure" && body.message).toContain("pruned 2");
		expect(body.type === "failure" && body.message).toContain("400 to 150");
	});

	it("marks an entry that carried an anomaly with a different code, so it can be routed", () => {
		const body = compactionEntry(
			{
				kept: [],
				pruned: [],
				summarised: ["x"],
				before: 100,
				after: 50,
				anomaly: { kind: "protected_over_ceiling", weight: 300, ceiling: 100 },
			},
			"pressure",
		);

		expect(body.type === "failure" && body.code).toBe("compaction_anomaly");
		expect(body.type === "failure" && body.message).toContain("ceiling of 100");
	});
});

describe("whether compaction cost the persona anything", () => {
	const envelopes = {
		"mood.tone": { mean: 0, min: -0.4, max: 0.4, range: 0.4 },
		"traits.humour": { mean: 0.5, min: 0.2, max: 0.8, range: 0.3 },
	} as never;

	it("reports clean when the persona did not move, which is what the rule requires", () => {
		const values = { "mood.tone": 0.1, "traits.humour": 0.55 };

		const delta = driftAcross(values, { ...values }, envelopes);

		expect(delta.clean).toBe(true);
		expect(delta.moved).toBe(0);
	});

	it("names the coordinates that got worse, which is the list worth looking at", () => {
		const delta = driftAcross(
			{ "mood.tone": 0, "traits.humour": 0.5 },
			{ "mood.tone": 0.3, "traits.humour": 0.5 },
			envelopes,
		);

		expect(delta.clean).toBe(false);
		expect(delta.worsened).toEqual(["mood.tone"]);
		expect(delta.moved).toBeGreaterThan(0);
	});

	it("does not call a move back toward the declared position a worsening", () => {
		const delta = driftAcross(
			{ "mood.tone": 0.3, "traits.humour": 0.5 },
			{ "mood.tone": 0, "traits.humour": 0.5 },
			envelopes,
		);

		expect(delta.worsened).toEqual([]);
		expect(delta.moved).toBeLessThan(0);
	});
});
