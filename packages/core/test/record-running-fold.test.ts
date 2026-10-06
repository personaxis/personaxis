/**
 * The journal keeps its fold up to date instead of redoing it.
 *
 * `state()` used to call `derive` over every entry, which verifies the whole chain
 * and folds it. It reads like an accessor and it is not one: writing a mutation asks
 * what the coordinate currently is, so a batch of five moves on a long history folded
 * and verified that history five times. Quadratic in a thing that only grows, hidden
 * behind a name that looks free.
 *
 * Two properties have to hold together, and only checking one of them passes with
 * either bug. The running fold has to agree with folding from scratch, or the
 * shortcut is wrong. And it has to stay flat as the history grows, or it is not a
 * shortcut.
 */

import { describe, expect, it } from "vitest";

import type { Envelope } from "../src/envelopes.js";
import { derive } from "../src/record/derive.js";
import { Journal } from "../src/record/journal.js";
import { mutate } from "../src/record/mutate.js";

const ENVELOPES: Record<string, Envelope> = {
	"mood.tone": { mean: 0, min: -1, max: 1 } as Envelope,
	"traits.openness": { mean: 0.5, min: 0, max: 1 } as Envelope,
};
const SELF = { kind: "persona", id: "self" } as const;

/** A journal with `n` moves written through the ordinary path. */
function moved(n: number): Journal {
	const journal = new Journal({});
	for (let i = 0; i < n; i += 1) {
		mutate(journal, ENVELOPES, SELF, {
			field: i % 2 === 0 ? "mood.tone" : "traits.openness",
			delta: 0.001,
			reason: `move ${i}`,
		});
	}
	return journal;
}

describe("the fold a journal keeps", () => {
	it("says the same thing as folding everything from scratch", () => {
		const journal = moved(50);

		const running = journal.state();
		const scratch = derive(journal.all());

		expect(running.ok && scratch.ok).toBe(true);
		if (!running.ok || !scratch.ok) return;
		expect(running.state).toEqual(scratch.state);
	});

	it("agrees after entries that are not coordinate moves", () => {
		// Turns, refusals and a checkpoint all change the fold in different ways, and a
		// running one that only handled values would drift from the real answer in a way
		// no test about coordinates would notice.
		const journal = moved(4);
		journal.append(SELF, { type: "turn-open", turn: "t1", prompt: "hola" });
		journal.append(SELF, {
			type: "call",
			turn: "t1",
			callId: "c1",
			tool: "shell",
			verdict: "denied",
			reason: "out_of_scope",
		});
		journal.append(SELF, {
			type: "turn-close",
			turn: "t1",
			outcome: "done",
			synthetic: false,
			spent: { steps: 2, tokens: 30, usd: 0.01 },
		});
		journal.checkpoint();
		mutate(journal, ENVELOPES, SELF, { field: "mood.tone", delta: 0.01, reason: "after" });

		const running = journal.state();
		const scratch = derive(journal.all());

		expect(running.ok && scratch.ok).toBe(true);
		if (!running.ok || !scratch.ok) return;
		expect(running.state).toEqual(scratch.state);
		expect(running.state.turnCount).toBe(1);
		expect(running.state.denialCount).toBe(1);
	});

	it("keeps saying a broken chain is broken, rather than folding on regardless", () => {
		// A journal opened on entries that do not verify has no state to report, and it
		// must keep having none. Remembering the failure is not the same as recomputing
		// it, and the version that recomputed would have been asked again on the next
		// call and could have answered differently.
		const journal = moved(3);
		const broken = journal.all().map((entry, index) =>
			index === 1 ? { ...entry, hash: "0".repeat(64) } : entry,
		);

		const reopened = new Journal({ initial: broken });

		expect(reopened.state().ok).toBe(false);
		reopened.append(SELF, { type: "failure", code: "x", message: "y" });
		expect(reopened.state().ok).toBe(false);
	});

	it("stays flat as the history grows, which is the whole point", () => {
		// A coarse bound rather than a ratio, because a ratio between two timings is
		// exactly the assertion that goes flaky on a loaded machine. Quadratic here is
		// not marginally slower: four thousand moves each folding the whole record is
		// tens of millions of hashes, seconds rather than milliseconds, so this bound
		// separates the two cases by orders of magnitude and nothing in between.
		const started = Date.now();
		const journal = moved(4000);
		const elapsed = Date.now() - started;

		expect(journal.all()).toHaveLength(4000);
		expect(elapsed).toBeLessThan(2000);
	});
});
