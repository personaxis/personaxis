/**
 * What the record promises, checked.
 *
 * The names are the promises. If one of these goes red, a header in `src/record/` has
 * become a lie, and the header is the thing to fix first.
 */

import { describe, expect, it } from "vitest";

import {
	Journal,
	chain,
	compareToStored,
	derive,
	head,
	recordLifecycle,
	replayStateFile,
	verify,
	type Author,
	type RecordEntry,
	type RecordSink,
} from "../src/record/index.js";
import { Kernel, serviceKey } from "../src/kernel/index.js";
import { applyMutation } from "../src/state-engine.js";
import type { Envelope } from "../src/envelopes.js";
import type { StateFile } from "../src/persona.js";

const PERSON: Author = { kind: "human", id: "david" };
const SELF: Author = { kind: "persona", id: "clio" };

/** A journal with fixed timestamps, so a hash is reproducible across runs. */
function journalAt(start = 0, sink?: RecordSink): Journal {
	let tick = start;
	return new Journal({
		now: () => new Date(Date.UTC(2026, 7, 22, 0, 0, tick++)),
		...(sink ? { sink } : {}),
	});
}

describe("nothing enters without saying who put it there", () => {
	it("refuses a chain whose entry has no author", () => {
		const journal = journalAt();
		journal.append(PERSON, { type: "turn-open", turn: "t1", prompt: "hola" });
		const entries = journal.all() as RecordEntry[];
		const forged = [{ ...entries[0]!, author: undefined as never }];

		expect(verify(forged).problem?.kind).toBe("no_author");
	});

	it("refuses a runtime author that will not say why it wrote", () => {
		// The runtime writing something is the case a reader most needs explained, so
		// an empty reason is as bad as no author at all.
		const entry = chain(
			{
				at: "2026-08-22T00:00:00.000Z",
				author: { kind: "runtime", mechanism: "compaction", reason: "" },
				body: { type: "failure", code: "x", message: "y" },
			},
			0,
			"",
		);

		expect(verify([entry]).problem?.kind).toBe("no_author");
	});

	it("puts the author inside the hash, so moving an entry onto a person breaks it", () => {
		// The cheapest forgery is not inventing an event. It is taking one a component
		// wrote and making it look like a person wrote it.
		const journal = journalAt();
		journal.append(
			{ kind: "component", name: "compactor" },
			{ type: "message", turn: "t1", role: "user", text: "do the thing" },
		);
		const entries = journal.all() as RecordEntry[];
		const forged = [{ ...entries[0]!, author: PERSON }];

		expect(verify(forged).problem?.kind).toBe("altered");
	});

	it("closes a crashed turn with a synthetic entry that says the runtime wrote it", () => {
		const journal = journalAt();
		journal.append(PERSON, { type: "turn-open", turn: "t1", prompt: "hola" });

		const closer = journal.closeCrashedTurn("the process died with the turn open");

		expect(closer?.body).toMatchObject({ type: "turn-close", synthetic: true });
		expect(closer?.author).toMatchObject({ kind: "runtime", mechanism: "crash-recovery" });
		const state = journal.state();
		expect(state.ok && state.state.openTurn).toBeUndefined();
	});

	it("does nothing when there is no crashed turn to close", () => {
		const journal = journalAt();
		journal.append(PERSON, { type: "turn-open", turn: "t1", prompt: "hola" });
		journal.append(SELF, { type: "turn-close", turn: "t1", outcome: "answered", synthetic: false });

		expect(journal.closeCrashedTurn("x")).toBeUndefined();
	});
});

describe("an altered entry breaks the chain", () => {
	it("catches an edited body", () => {
		const journal = journalAt();
		journal.append(PERSON, {
			type: "value",
			field: "mood.tone",
			from: 0,
			to: 0.1,
			requested: 0.1,
			clamped: false,
			blocked: false,
			reason: "warmed up",
		});
		const entries = journal.all() as RecordEntry[];
		const forged = [
			{ ...entries[0]!, body: { ...entries[0]!.body, to: 0.9 } as never },
		];

		expect(verify(forged).problem).toEqual({ kind: "altered", seq: 0 });
	});

	it("catches a deleted middle entry", () => {
		const journal = journalAt();
		for (let index = 0; index < 3; index += 1) {
			journal.append(PERSON, { type: "turn-open", turn: `t${index}`, prompt: "x" });
		}
		const entries = journal.all() as RecordEntry[];

		const gapped = [entries[0]!, entries[2]!];

		expect(verify(gapped).ok).toBe(false);
	});

	it("catches two entries swapped, even when both are otherwise valid", () => {
		// Order is not decoration: state is a fold, and a fold over a different order
		// is a different state. That is why the sequence number is inside the hash.
		const journal = journalAt();
		journal.append(PERSON, { type: "turn-open", turn: "a", prompt: "x" });
		journal.append(PERSON, { type: "turn-open", turn: "b", prompt: "x" });
		const entries = journal.all() as RecordEntry[];

		expect(verify([entries[1]!, entries[0]!]).ok).toBe(false);
	});

	it("hashes over content and not over key order", () => {
		// Otherwise the chain verifies in the process that wrote it and nowhere else,
		// which is the failure that only shows up once an entry crosses a wire.
		const body = { type: "failure", code: "boom", message: "m", subject: "s" } as const;
		const straight = chain({ at: "t", author: PERSON, body }, 0, "");
		const shuffled = chain(
			{
				author: { id: "david", kind: "human" } as Author,
				body: { subject: "s", message: "m", code: "boom", type: "failure" } as never,
				at: "t",
			},
			0,
			"",
		);

		expect(shuffled.hash).toBe(straight.hash);
	});

	it("reports the first problem and stops, because everything after it is suspect", () => {
		const journal = journalAt();
		for (let index = 0; index < 4; index += 1) {
			journal.append(PERSON, { type: "turn-open", turn: `t${index}`, prompt: "x" });
		}
		const entries = journal.all() as RecordEntry[];
		const forged = [...entries];
		forged[1] = { ...forged[1]!, prev: "wrong" };

		expect(verify(forged).problem).toEqual({ kind: "broken_link", seq: 1 });
	});
});

describe("the state is a fold and nothing else", () => {
	it("refuses to derive from a chain that does not verify", () => {
		// A number derived from entries that may have been edited is worse than no
		// number, because somebody will quote it.
		const journal = journalAt();
		journal.append(PERSON, {
			type: "value",
			field: "a",
			from: 0,
			to: 1,
			requested: 1,
			clamped: false,
			blocked: false,
			reason: "x",
		});
		const forged = (journal.all() as RecordEntry[]).map((entry) => ({ ...entry, hash: "nope" }));

		expect(derive(forged).ok).toBe(false);
	});

	it("takes the last value per field", () => {
		const journal = journalAt();
		for (const to of [0.2, 0.5, 0.4]) {
			journal.append(SELF, {
				type: "value",
				field: "mood.tone",
				from: 0,
				to,
				requested: to,
				clamped: false,
				blocked: false,
				reason: "x",
			});
		}

		const result = journal.state();
		expect(result.ok && result.state.values["mood.tone"]).toBe(0.4);
	});

	it("records a blocked mutation without moving the value", () => {
		const journal = journalAt();
		journal.append(SELF, {
			type: "value",
			field: "honesty",
			from: 0.9,
			to: 0.9,
			requested: -0.4,
			clamped: false,
			blocked: true,
			reason: "governance refused",
		});

		const result = journal.state();
		expect(result.ok && result.state.values["honesty"]).toBe(0.9);
	});

	it("surfaces refused calls, which is the half an audit reads first", () => {
		const journal = journalAt();
		journal.append(SELF, {
			type: "call",
			turn: "t1",
			callId: "c1",
			tool: "shell",
			verdict: "denied",
			reason: "out_of_scope",
		});
		journal.append(SELF, {
			type: "call",
			turn: "t1",
			callId: "c2",
			tool: "read",
			verdict: "allowed",
		});

		const result = journal.state();
		expect(result.ok && result.state.denials).toEqual([
			{ turn: "t1", callId: "c1", tool: "shell", reason: "out_of_scope" },
		]);
	});
});

describe("writes are visible now and durable later", () => {
	it("makes an entry readable before anything reaches the sink", () => {
		const journal = journalAt(0, { append: async () => {} });
		journal.append(SELF, {
			type: "value",
			field: "a",
			from: 0,
			to: 1,
			requested: 1,
			clamped: false,
			blocked: false,
			reason: "x",
		});

		const result = journal.state();
		expect(result.ok && result.state.values["a"]).toBe(1);
		expect(journal.pending).toBe(1);
	});

	it("drains what is pending and nothing else", async () => {
		const written: RecordEntry[][] = [];
		const journal = journalAt(0, {
			append: async (entries) => {
				written.push([...entries]);
			},
		});
		journal.append(PERSON, { type: "turn-open", turn: "t1", prompt: "x" });
		await journal.drain();
		journal.append(SELF, { type: "turn-close", turn: "t1", outcome: "ok", synthetic: false });
		await journal.drain();

		expect(written.map((batch) => batch.length)).toEqual([1, 1]);
		expect(journal.pending).toBe(0);
	});

	it("keeps entries pending when the sink refuses, rather than reporting success", async () => {
		// The one failure a record cannot have is believing something was written when
		// it was not.
		const journal = journalAt(0, {
			append: async () => {
				throw new Error("disk full");
			},
		});
		journal.append(PERSON, { type: "turn-open", turn: "t1", prompt: "x" });

		const report = await journal.drain();

		expect(report.written).toBe(0);
		expect(report.failure?.message).toBe("disk full");
		expect(journal.pending).toBe(1);
	});

	it("joins a drain already in flight instead of writing the window twice", async () => {
		let calls = 0;
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const journal = journalAt(0, {
			append: async () => {
				calls += 1;
				await gate;
			},
		});
		journal.append(PERSON, { type: "turn-open", turn: "t1", prompt: "x" });

		const first = journal.drain();
		const second = journal.drain();
		release();
		await Promise.all([first, second]);

		expect(calls).toBe(1);
	});

	it("treats recovered entries as already durable, so a restart does not rewrite history", () => {
		const source = journalAt();
		source.append(PERSON, { type: "turn-open", turn: "t1", prompt: "x" });

		const resumed = new Journal({ initial: source.all(), sink: { append: async () => {} } });

		expect(resumed.pending).toBe(0);
	});
});

describe("the kernel's lifecycle goes into the same record", () => {
	it("writes a mount with the epoch it resolved to", () => {
		const CLOCK = serviceKey<number>("clock");
		const kernel = new Kernel();
		const journal = journalAt();
		recordLifecycle(kernel, journal);

		kernel.provide(CLOCK, 1);
		kernel.mount({ name: "reader", needs: [CLOCK], activate: () => {} });

		const entries = journal.all();
		const activated = entries.find(
			(entry) => entry.body.type === "lifecycle" && entry.body.to === "active",
		);
		expect(activated?.body).toMatchObject({ component: "reader" });
		expect((activated?.body as { epoch?: string }).epoch).toContain("clock@");
	});

	it("attributes a suspension to the kernel and not to the component", () => {
		// A component did not decide to be suspended. Putting the entry in its mouth
		// would be attributing a decision it never made.
		const CLOCK = serviceKey<number>("clock");
		const kernel = new Kernel();
		const journal = journalAt();
		recordLifecycle(kernel, journal);
		const drop = kernel.provide(CLOCK, 1);
		kernel.mount({ name: "reader", needs: [CLOCK], activate: () => {} });

		drop();

		const suspended = journal
			.all()
			.find((entry) => entry.body.type === "lifecycle" && entry.body.to === "suspended");
		expect(suspended?.author).toMatchObject({ kind: "runtime", mechanism: "kernel" });
	});

	it("answers what a persona could reach, from the fold alone", () => {
		const CLOCK = serviceKey<number>("clock");
		const kernel = new Kernel();
		const journal = journalAt();
		recordLifecycle(kernel, journal);
		kernel.provide(CLOCK, 1);
		kernel.mount({ name: "reader", needs: [CLOCK], activate: () => {} });

		const result = journal.state();
		expect(result.ok && result.state.components["reader"]?.state).toBe("active");
	});
});

describe("deriving gives what the stored copy says", () => {
	const envelopes: Record<string, Envelope> = {
		"mood.tone": { mean: 0, min: -0.4, max: 0.4, range: 0.4 } as Envelope,
		"traits.humour": { mean: 0.5, min: 0.2, max: 0.8, range: 0.3 } as Envelope,
	};

	function freshState(): StateFile {
		return {
			schema_version: "1.1.0",
			persona_id: "clio",
			persona_version: "1.0.0",
			values: {},
			mutation_log: [],
		};
	}

	it("matches after a run of ordinary mutations", () => {
		const state = freshState();
		applyMutation(state, envelopes, { field: "mood.tone", delta: 0.2, reason: "a" });
		applyMutation(state, envelopes, { field: "traits.humour", delta: 0.1, reason: "b" });
		applyMutation(state, envelopes, { field: "mood.tone", delta: -0.05, reason: "c" });

		// Two genesis entries, one per coordinate the log touched, then the three
		// mutations. Genesis is what stops a value existing with nobody named.
		expect(compareToStored(state)).toMatchObject({ ok: true, folded: 5 });
	});

	it("matches when a mutation was clamped to its envelope", () => {
		const state = freshState();
		applyMutation(state, envelopes, { field: "mood.tone", delta: 5, reason: "way over" });

		const report = compareToStored(state);
		expect(report.ok).toBe(true);
		expect(state.values["mood.tone"]).toBe(0.4);
	});

	it("matches when governance blocked a mutation", () => {
		const state = freshState();
		applyMutation(state, envelopes, {
			field: "mood.tone",
			delta: 0.3,
			reason: "refused",
			governanceBlocked: true,
		});

		expect(compareToStored(state).ok).toBe(true);
	});

	it("counts the coordinates whose value nobody wrote down a reason for", () => {
		// Not a failure, and deliberately not reported as one. It is how much of a
		// persona's position rests on a genesis entry reconstructed after the fact.
		const state = freshState();
		applyMutation(state, envelopes, { field: "mood.tone", delta: 0.1, reason: "a" });
		state.values["traits.humour"] = 0.7;

		const report = compareToStored(state);
		expect(report.ok).toBe(true);
		expect(report.unaudited).toEqual(["traits.humour"]);
	});

	it("names a field where the log and the stored copy disagree", () => {
		const state = freshState();
		applyMutation(state, envelopes, { field: "mood.tone", delta: 0.1, reason: "a" });
		state.values["mood.tone"] = 0.35;

		const report = compareToStored(state);
		expect(report.ok).toBe(false);
		expect(report.mismatches[0]).toMatchObject({ field: "mood.tone", stored: 0.35 });
	});

	it("gives a decayed value the runtime as its author, not a person", () => {
		// The old schema defaulted a missing actor to a human operator, which is the
		// exact shape of the bug the invariant exists to stop. The migration undoes it.
		const state = freshState();
		applyMutation(state, envelopes, {
			field: "mood.tone",
			delta: -0.1,
			reason: "half-life",
			actor: "runtime-decay",
		});

		const replayed = replayStateFile(state);
		const mutation = replayed.find(
			(entry) => entry.body.type === "value" && entry.body.reason === "half-life",
		);
		expect(mutation?.author).toMatchObject({ kind: "runtime", mechanism: "homeostasis" });
	});

	it("replays a real persona's log without a break in the chain", () => {
		const state = freshState();
		for (let index = 0; index < 40; index += 1) {
			applyMutation(state, envelopes, {
				field: index % 2 === 0 ? "mood.tone" : "traits.humour",
				delta: index % 3 === 0 ? 0.07 : -0.05,
				reason: `step ${index}`,
				actor: index % 5 === 0 ? "runtime-decay" : "actor-llm",
			});
		}

		const replayed = replayStateFile(state);
		expect(verify(replayed).ok).toBe(true);
		expect(compareToStored(state).ok).toBe(true);
	});
});

describe("the provider's material stays outside the chain", () => {
	it("keeps the text and a reference with its issuer stamped", () => {
		const journal = journalAt();
		journal.append(SELF, {
			type: "message",
			turn: "t1",
			role: "assistant",
			text: "the answer",
			artifacts: [{ issuer: "provider-a", kind: "reasoning-signature", ref: "blob/1" }],
		});

		const entry = journal.all()[0]!;
		const body = entry.body as { artifacts?: { issuer: string }[] };
		expect(body.artifacts?.[0]!.issuer).toBe("provider-a");
		// The chain holds the reference, so a consumer can ask whether an artifact was
		// ours before trying to replay it, without having the artifact.
		expect(JSON.stringify(entry)).not.toContain("blob-contents");
	});
});

describe("the head is what the next entry points at", () => {
	it("is empty for an empty record", () => {
		expect(head([])).toBe("");
	});
});
