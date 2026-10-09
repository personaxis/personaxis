/**
 * A compaction ends up in the record, with its author, naming what it moved.
 *
 * E25. Everything needed for this existed and none of it was connected:
 * `compactionEntry` builds the body, `compactionAuthor` builds the author, and the
 * runner has written turns into the record since `run/recording.ts` was written. What
 * was missing sat one level down, in the loop: `CompactionPlan` names units by id and
 * the loop carries messages with no id, so there was nothing to put in the entry.
 *
 * So the first half of this file is about identity, because that is the whole blockage,
 * and the property that matters is not "an id exists". It is that the id is checkable
 * by a reader holding the transcript and survives the operation it documents. A
 * generated id fails the first, an index fails the second, and both look fine in a test
 * that only asserts the field is populated.
 *
 * ## The drift half, and why it is an assertion rather than a measurement
 *
 * The row asks for the compaction's drift as well as its author. Measured at runtime it
 * would be theatre: `derive` folds a `failure` body into nothing, deliberately and with
 * a comment saying so, and a compaction writes a `failure` body. So the persona's
 * position across a compaction is unchanged by construction, and computing a number
 * that construction already fixes at zero is a measurement of the code's own shape.
 *
 * What is worth having is the guard. `compaction must not move the persona` is a claim
 * this repository makes out loud, and the thing that could break it is somebody giving
 * compaction a body type that folds. That is what the last describe block is: derive
 * before, derive after, and assert both the values and the drift report agree that
 * nothing moved. It goes red the day the entry starts touching state, which is the only
 * day the claim is in danger.
 */

import { describe, expect, it } from "vitest";

import { compactMessages, ContextMeter, type ChatMessage } from "../src/index.js";
import { compactionPlan } from "../src/compaction/units.js";
import { compactionAuthor, compactionEntry, driftAcross } from "../src/compaction/measured.js";
import { derive, type DerivedState } from "../src/record/derive.js";
import { Journal } from "../src/record/journal.js";
import { Ledger } from "../src/run/budget.js";
import { recordTurns } from "../src/run/recording.js";
import { TurnRunner } from "../src/run/service.js";
import type { Envelope } from "../src/envelopes.js";
import type { RecordBody } from "../src/record/entry.js";
import type { TurnCompaction, TurnRequest } from "../src/run/vocabulary.js";

const ASKED: TurnRequest = {
	turn: "t1",
	prompt: "summarise the branch",
	asker: { kind: "human", id: "mara" },
};

/** A summariser that answers, so a compaction actually happens. */
const summariser = {
	endpoint: "http://x/v1",
	model: "m",
	fetchImpl: (async () => ({
		ok: true,
		status: 200,
		json: async () => ({ choices: [{ message: { content: "a condensed history" } }] }),
	})) as unknown as typeof fetch,
};

/** A transcript with a three-message system prefix and enough history to compact. */
function transcript(turns: number): ChatMessage[] {
	return [
		{ role: "system", content: "# Identity\nYou are Tester." },
		{ role: "system", content: "# Skill guide\nHow to write a report." },
		{ role: "system", content: "# Recent memory\nThe user's dog is called Ada." },
		...Array.from({ length: turns }, (_, index) => ({
			role: (index % 2 === 0 ? "user" : "assistant") as ChatMessage["role"],
			content: `turn ${index}`,
		})),
	];
}

/** A meter already over the threshold, so `compactMessages` does the work. */
function fullMeter(): ContextMeter {
	const meter = new ContextMeter(1000);
	meter.used = 950;
	return meter;
}

function runnerWith(
	compactions: readonly TurnCompaction[] | undefined,
	into?: Journal,
): { runner: TurnRunner; journal: Journal } {
	const journal = into ?? new Journal({});
	const runner = new TurnRunner({
		provider: {
			name: "scripted",
			run: async () => ({
				answer: "done",
				steps: 1,
				...(compactions === undefined ? {} : { compactions }),
			}),
		} as never,
		observer: recordTurns({ journal }),
		ledger: new Ledger({ steps: 10 }),
	});
	return { runner, journal };
}

function bodies(journal: Journal): RecordBody[] {
	return journal.all().map((entry) => entry.body);
}

/**
 * What a message is called, read off the only surface that says so.
 *
 * The digest is private to `units.ts` on purpose: an export whose only caller is its own
 * test is what the connectedness ratchet is for. Going through `compactionPlan` also
 * makes these assertions the ones a consumer can actually make, which is the honest
 * place to prove a property from.
 */
function idOf(message: ChatMessage): string {
	return compactionPlan({ kept: [message], summarised: [], before: 0, after: 0 }).kept[0]!;
}

/** The same, for a list, since that is how a plan is usually compared. */
function idsOf(messages: readonly ChatMessage[]): readonly string[] {
	return compactionPlan({ kept: messages, summarised: [], before: 0, after: 0 }).kept;
}

describe("what a message is called", () => {
	it("is a digest of the message, so a reader with the transcript can check it", () => {
		// The property that rules out a generated id. Nothing is stored and nothing is
		// remembered: the name is recomputed from the thing it names.
		const message: ChatMessage = { role: "user", content: "where is the config" };

		expect(idOf(message)).toBe(idOf({ role: "user", content: "where is the config" }));
		expect(idOf(message)).toMatch(/^u[0-9a-f]{16}$/);
	});

	it("does not change when the message moves", () => {
		// The property that rules out an index. Compaction is precisely the operation
		// that changes every position after the cut, so an id built from a position
		// would not survive the event it exists to document.
		const message: ChatMessage = { role: "assistant", content: "checked" };
		const early = [message, { role: "user" as const, content: "next" }];
		const late = [{ role: "user" as const, content: "a" }, { role: "user" as const, content: "b" }, message];

		expect(idOf(early[0]!)).toBe(idOf(late[2]!));
	});

	it("separates messages that differ in anything the model would see", () => {
		const base: ChatMessage = { role: "tool", content: "ok", tool_call_id: "c1", name: "read_file" };
		const ids = new Set([
			idOf(base),
			idOf({ ...base, role: "user" }),
			idOf({ ...base, content: "ok " }),
			idOf({ ...base, tool_call_id: "c2" }),
			idOf({ ...base, name: "list_dir" }),
		]);

		expect(ids.size).toBe(5);
	});

	it("does not depend on the order the message was built in", () => {
		// Canonical bytes, the same rule the chain follows. Two processes that built the
		// same message with their keys in a different order have to agree on its name,
		// or a transcript that crossed a wire gets renamed on arrival.
		const one: ChatMessage = { role: "tool", content: "ok", tool_call_id: "c1" };
		const other: ChatMessage = { tool_call_id: "c1", content: "ok", role: "tool" };

		expect(idOf(one)).toBe(idOf(other));
	});

	it("gives two identical messages one name, and the counts stay true", () => {
		// The known consequence of a content digest, and it is the honest answer:
		// disambiguating by occurrence is a position wearing a different hat. Nothing is
		// lost, because a plan holds lists and not sets.
		const twice: ChatMessage[] = [
			{ role: "assistant", content: "let me try again" },
			{ role: "assistant", content: "let me try again" },
		];
		const plan = compactionPlan({ kept: twice, summarised: [], before: 10, after: 10 });

		expect(plan.kept).toHaveLength(2);
		expect(new Set(plan.kept).size).toBe(1);
	});
});

describe("what a compaction says it did", () => {
	it("names the messages it summarised and the ones it kept", async () => {
		const messages = transcript(30);
		const older = messages.slice(3, messages.length - 10);
		const recent = messages.slice(messages.length - 10);

		const result = await compactMessages(messages, fullMeter(), { llm: summariser });

		expect(result.compacted).toBe(true);
		expect(result.plan?.summarised).toEqual(idsOf(older));
		expect(result.plan?.kept).toEqual(idsOf(recent));
	});

	it("leaves out the system prefix, which was never at risk", () => {
		// `kept` means offered up and survived. Counting a block compaction is not
		// allowed to touch would make a plan look like it protected something when it
		// had simply not been asked.
		const messages = transcript(30);
		const systemIds = idsOf(messages.slice(0, 3));

		return compactMessages(messages, fullMeter(), { llm: summariser }).then((result) => {
			const named = [...(result.plan?.kept ?? []), ...(result.plan?.summarised ?? [])];
			for (const id of systemIds) expect(named).not.toContain(id);
		});
	});

	it("leaves out what the compaction produced, which it was not given", async () => {
		const messages = transcript(30);

		const result = await compactMessages(messages, fullMeter(), {
			llm: summariser,
			pinned: "GOAL: ship the branch",
		});

		const named = [...(result.plan?.kept ?? []), ...(result.plan?.summarised ?? [])];
		const produced = result.messages.filter(
			(message) => message.content.includes("<summary>") || message.content.includes("GOAL:"),
		);
		expect(produced.length).toBeGreaterThan(0);
		for (const message of produced) expect(named).not.toContain(idOf(message));
	});

	it("names every unit with an id that recomputes from a message that was there", async () => {
		// The whole point of a content digest, asserted as a reader would use it: take
		// the plan, take the transcript it was given, and check the plan is talking about
		// that transcript and not about something it invented.
		const messages = transcript(30);
		const before = idsOf(messages);

		const result = await compactMessages(messages, fullMeter(), { llm: summariser });

		const named = [...(result.plan?.kept ?? []), ...(result.plan?.summarised ?? [])];
		expect(named.length).toBeGreaterThan(0);
		for (const id of named) expect(before).toContain(id);
	});

	it("says nothing when nothing was compacted", async () => {
		// A plan describing a compaction that did not happen is a plan somebody reads to
		// find out it says nothing.
		const meter = new ContextMeter(1000);
		meter.used = 10;

		const result = await compactMessages(transcript(30), meter, { llm: summariser });

		expect(result.compacted).toBe(false);
		expect(result.plan).toBeUndefined();
	});

	it("reports the tokens either side, so the saving is a number and not a claim", async () => {
		const meter = fullMeter();

		const result = await compactMessages(transcript(30), meter, { llm: summariser });

		expect(result.plan?.before).toBe(950);
		expect(result.plan?.after).toBe(meter.used);
		expect(result.plan!.after).toBeLessThan(result.plan!.before);
	});
});

describe("a compaction in the record", () => {
	const plan = compactionPlan({
		kept: [{ role: "user", content: "recent" }],
		summarised: [{ role: "user", content: "old" }],
		before: 900,
		after: 300,
	});

	it("is written with the runtime as its author, never the persona", async () => {
		// The forgery the author invariant exists to prevent, in its compaction-shaped
		// form: the persona did not decide to forget anything, the runtime did.
		const { runner, journal } = runnerWith([{ why: "turn-start at step 1", plan }]);

		await runner.run(ASKED);

		const entry = journal.all().find((row) => row.body.type === "failure")!;
		expect(entry.author).toEqual({
			kind: "runtime",
			mechanism: "compaction",
			reason: "turn-start at step 1",
		});
		// Named separately, because `kind` is what makes the rest of the author readable
		// at all: `reason` lives on the runtime member of the union and nowhere else.
		expect(entry.author.kind).toBe("runtime");
	});

	it("says what was moved and what it bought", async () => {
		const { runner, journal } = runnerWith([{ why: "window-full at step 9", plan }]);

		await runner.run(ASKED);

		expect(bodies(journal)).toContainEqual({
			type: "failure",
			code: "compaction",
			message: "window-full at step 9: pruned 0, summarised 1, kept 1, 900 to 300",
			subject: "compaction",
		});
	});

	it("comes before the answer, because that is when it happened", async () => {
		const { runner, journal } = runnerWith([{ why: "turn-start at step 1", plan }]);

		await runner.run(ASKED);

		expect(bodies(journal).map((body) => body.type)).toEqual([
			"turn-open",
			"failure",
			"message",
			"turn-close",
		]);
	});

	it("writes one entry per compaction, in the order they happened", async () => {
		const { runner, journal } = runnerWith([
			{ why: "turn-start at step 1", plan },
			{ why: "window-full at step 7", plan },
		]);

		await runner.run(ASKED);

		const reasons = journal
			.all()
			.filter((row) => row.body.type === "failure")
			.map((row) => (row.author.kind === "runtime" ? row.author.reason : row.author.kind));
		expect(reasons).toEqual(["turn-start at step 1", "window-full at step 7"]);
	});

	it("writes nothing when the provider manages no window", async () => {
		const { runner, journal } = runnerWith(undefined);

		await runner.run(ASKED);

		expect(bodies(journal).map((body) => body.type)).toEqual(["turn-open", "message", "turn-close"]);
	});

	it("writes nothing when the provider compacted nothing", async () => {
		// Silence and "I looked and there was nothing" are different statements at the
		// seam and the same absence of an event in a chain. A record whose value is that
		// everything in it happened does not carry notes about what did not.
		const { runner, journal } = runnerWith([]);

		await runner.run(ASKED);

		expect(bodies(journal).map((body) => body.type)).toEqual(["turn-open", "message", "turn-close"]);
	});

	it("marks the anomaly with its own code, so it can be routed", async () => {
		const { runner, journal } = runnerWith([
			{
				why: "window-full at step 9",
				plan: {
					...plan,
					anomaly: { kind: "protected_over_ceiling", weight: 4000, ceiling: 2000 },
				},
			},
		]);

		await runner.run(ASKED);

		const entry = bodies(journal).find((body) => body.type === "failure")!;
		expect(entry.type).toBe("failure");
		if (entry.type !== "failure") throw new Error("not a failure body");
		expect(entry.code).toBe("compaction_anomaly");
		expect(entry.message).toContain("protected region at 4000 against a ceiling of 2000");
	});
});

describe("what a compaction costs the persona", () => {
	/**
	 * A journal already holding a coordinate move, so the state has something to lose.
	 *
	 * One journal and one chain, not two sets of entries concatenated. Entries chain
	 * onto the head they were written against, so two independently built lists laid end
	 * to end do not verify and `derive` correctly refuses to report a state for them.
	 * A test that spliced them would be measuring its own splice.
	 */
	function seeded(): Journal {
		const journal = new Journal({});
		journal.append(
			{ kind: "runtime", mechanism: "test", reason: "set up a position" },
			{
				type: "value",
				field: "warmth",
				from: 0.5,
				to: 0.8,
				delta: 0.3,
				clamped: false,
				blocked: false,
				reason: "seed",
			},
		);
		return journal;
	}

	const envelopes: Record<string, Envelope> = { warmth: { mean: 0.5, min: 0, max: 1 } };

	/** The whole derived state, or a failure loud enough to read. */
	function stateOf(journal: Journal): DerivedState {
		const derived = derive([...journal.all()]);
		if (!derived.ok) throw new Error(`the chain did not verify: ${derived.problem.kind}`);
		return derived.state;
	}

	/** The coordinates on their own, for the drift report. */
	function valuesOf(journal: Journal): Record<string, number> {
		return { ...stateOf(journal).values };
	}

	it("leaves the persona exactly where the same turn without one leaves it", async () => {
		// The strongest form of the claim, and the reason it is worth the second journal:
		// two identical turns, one that compacted and one that did not, and the persona
		// they produce compared WHOLE. Comparing only the coordinates would miss a
		// compaction that started folding into anything else the state carries, which is
		// the realistic way this breaks: not somebody writing a coordinate move, somebody
		// giving the entry a body type that happens to fold.
		const compacted = seeded();
		const untouched = seeded();

		await runnerWith(
			[
				{
					why: "turn-start at step 1",
					plan: compactionPlan({
						kept: [{ role: "user", content: "recent" }],
						summarised: [{ role: "user", content: "old" }],
						before: 900,
						after: 300,
					}),
				},
			],
			compacted,
		).runner.run(ASKED);
		await runnerWith([], untouched).runner.run(ASKED);

		// `through` is held out and then asserted on, because it is the one field that
		// MUST differ: it counts entries folded, and the compacted run has one more. Held
		// out silently it would be a hole; asserted, it is the proof the entry actually
		// landed, which is what stops this test from passing because nothing was written.
		const { through: withOne, ...moved } = stateOf(compacted);
		const { through: without, ...still } = stateOf(untouched);

		expect(moved).toEqual(still);
		expect(withOne).toBe(without + 1);
	});

	it("moves nothing, because a compaction is not a thing that happened to the persona", async () => {
		// The claim, asserted rather than computed. `derive` folds a `failure` body into
		// nothing on purpose, so this is zero by construction, and this test is what goes
		// red the day compaction is given a body type that folds.
		const journal = seeded();
		const before = valuesOf(journal);

		const { runner } = runnerWith(
			[
				{
					why: "turn-start at step 1",
					plan: compactionPlan({
						kept: [{ role: "user", content: "recent" }],
						summarised: [{ role: "user", content: "old" }],
						before: 900,
						after: 300,
					}),
				},
			],
			journal,
		);
		await runner.run(ASKED);
		const after = valuesOf(journal);

		expect(before).toEqual({ warmth: 0.8 });
		expect(after).toEqual(before);
		expect(driftAcross(before, after, envelopes).clean).toBe(true);
	});

	it("is still in the chain, so what it did can be read back", async () => {
		// The other half of the same property, and the reason it is worth stating: the
		// persona did not move AND the compaction is not invisible. A rewrite that left
		// no trace would also pass the test above.
		const { runner, journal } = runnerWith([
			{
				why: "window-full at step 4",
				plan: compactionPlan({
					kept: [{ role: "user", content: "recent" }],
					summarised: [{ role: "user", content: "old" }],
					before: 900,
					after: 300,
				}),
			},
		]);

		await runner.run(ASKED);

		const written = journal.all().filter((row) => row.body.type === "failure");
		expect(written).toHaveLength(1);
		expect(journal.verify().ok).toBe(true);
	});
});

describe("what an entry is built from", () => {
	it("carries the reason once, so the author and the message cannot drift", () => {
		// Two accounts of one trigger is the divergence this repository spends most of
		// its rules preventing. The seam carries `why` and both halves read it.
		const why = "turn-start at step 1";
		const plan = compactionPlan({ kept: [], summarised: [], before: 5, after: 5 });

		const author = compactionAuthor(why);
		expect(author.kind === "runtime" && author.reason).toBe(why);

		const body = compactionEntry(plan, why);
		if (body.type !== "failure") throw new Error("not a failure body");
		expect(body.message).toContain(why);
	});
});
