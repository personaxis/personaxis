// What one step tells the next one.
//
// The failure mode is silent in both directions: a handover that says nothing
// leaves the next step guessing, and one that says too much pushes the
// instruction out of sight. Neither throws.
//
// EVERYTHING IS ASSERTED THROUGH `handoverText`, and that is the gate's doing
// rather than a preference. The first draft exported the note reader and both
// limits so the tests could reach them, and `designed-not-connected` failed:
// three exports whose only consumer was this file. Going through the public
// function is the better test anyway, because it is what the product calls.

import { describe, expect, it } from "vitest";

import {
	chronological,
	describeProduced,
	handoverText,
	producedFrom,
	retakeText,
	stepPrompt,
	type PreviousStep,
} from "../../src/service/handover.js";

const turn = (summary?: string) => ({
	kind: "agent.turn.ended",
	payload: summary === undefined ? {} : { summary },
});
const call = { kind: "tool.call.requested", payload: { tool: "Bash" } };

const step = (
	position: number,
	entries: PreviousStep["entries"],
	name = `Step ${position}`,
): PreviousStep => ({
	position,
	name,
	personaName: "Someone",
	entries,
});

describe("the note a step leaves", () => {
	it("is the last thing the agent said", () => {
		// Not the first, and not all of them joined: a session's closing word is
		// what the next step is being handed.
		const text = handoverText(
			[step(1, [turn("started looking"), call, turn("wrote six lines")])],
			null,
		)!;
		expect(text).toContain("wrote six lines");
		expect(text).not.toContain("started looking");
	});

	it("says a step left no note rather than leaving a gap", () => {
		// A real outcome: a step that only edited files leaves its work in the
		// folder and no words behind. Inventing a summary would be putting words
		// in somebody's mouth, in a record.
		expect(handoverText([step(1, [call, turn()])], null)).toContain("Left no note");
		expect(handoverText([step(1, [turn("   ")])], null)).toContain("Left no note");
	});

	it("survives a record shaped wrong instead of throwing", () => {
		// The record is JSON out of a database, so its shape is a hope.
		const broken = [
			{ kind: "agent.turn.ended", payload: null },
			{ kind: "agent.turn.ended", payload: { summary: 42 } },
		];
		expect(handoverText([step(1, broken)], null)).toContain("Left no note");
	});

	it("trims a note that would swallow the prompt, and says it did", () => {
		const long = "x".repeat(5_000);
		const text = handoverText([step(1, [turn(long)])], null)!;
		expect(text.length).toBeLessThan(long.length);
		expect(text).toContain("the rest of this note is in the run's record");
	});
});

describe("a record read newest first", () => {
	it("comes back in the order things happened, so the last word is the newest", () => {
		// The cap is the reason this exists. An ascending read that is cut keeps the
		// OLDEST entries, so a step with more turns than the cap handed over the note
		// from its first two hundred while its comment claimed the tail mattered.
		const newestFirst = [
			{ kind: "agent.turn.ended", payload: { summary: "the closing word" } },
			{ kind: "agent.turn.ended", payload: { summary: "something early" } },
		];

		expect(handoverText([step(1, chronological(newestFirst))], null)).toContain(
			"the closing word",
		);
	});
});

describe("the handover block", () => {
	it("is null for the first step", () => {
		// Not an empty section. A first step told "here is what came before:
		// nothing" is being handed a puzzle instead of a task.
		expect(handoverText([], "/work/acme")).toBeNull();
	});

	it("names each step, its persona and its note, in order", () => {
		const text = handoverText(
			[step(2, [turn("second thing")]), step(1, [turn("first thing")])],
			"/work/acme",
		)!;

		expect(text.indexOf("first thing")).toBeLessThan(text.indexOf("second thing"));
		expect(text).toContain("Step 1");
		expect(text).toContain("Someone");
	});

	it("points at the folder, which is the durable half", () => {
		// The note is words; the folder is the work. A handover that mentioned only
		// the note would describe a service whose steps cannot pass files.
		expect(handoverText([step(1, [turn("done")])], "/work/acme")).toContain("/work/acme");
		expect(handoverText([step(1, [turn("done")])], null)).toContain(
			"the same folder you are in",
		);
	});

	it("does not repeat the name when the step is called after its persona", () => {
		// It read "Step 1: The Watcher (The Watcher)" the first time, which is
		// what one field doing two jobs looks like on a screen.
		const same: PreviousStep = {
			position: 1,
			name: "The Watcher",
			personaName: "The Watcher",
			entries: [turn("done")],
		};
		expect(handoverText([same], null)).toContain("Step 1: The Watcher\n");
		expect(handoverText([same], null)).not.toContain("(The Watcher)");
	});

	it("keeps the persona in brackets when the step is called something else", () => {
		const named: PreviousStep = {
			position: 1,
			name: "Read the diffs",
			personaName: "The Watcher",
			entries: [turn("done")],
		};
		expect(handoverText([named], null)).toContain("Step 1: Read the diffs (The Watcher)");
	});

	it("keeps the newest steps when it has to cut, and says how many it dropped", () => {
		// A silent truncation is a lie about what the previous steps did, and it
		// lands on the LAST step of a long service, which is the most expensive
		// place to find out.
		const fat = "y".repeat(2_900);
		const many = [1, 2, 3, 4, 5, 6].map((position) => step(position, [turn(fat)]));

		const text = handoverText(many, "/work/acme")!;
		expect(text).toContain("earlier step(s) omitted");
		// The most recent survives; the oldest is the one dropped.
		expect(text).toContain("Step 6");
		expect(text).not.toContain("Step 1:");
		// And the whole thing stays a few pages rather than a transcript.
		expect(text.length).toBeLessThan(15_000);
	});
});

describe("the prompt a step is given", () => {
	it("puts the instruction first", () => {
		// The opposite of chronological, deliberately: an agent handed a transcript
		// before a task treats the task as a footnote to the transcript.
		const prompt = stepPrompt(
			"Write the notes.",
			handoverText([step(1, [turn("done")])], null),
		);
		expect(prompt.startsWith("Write the notes.")).toBe(true);
	});

	it("is the instruction alone when there is nothing before it", () => {
		expect(stepPrompt("Write the notes.", null)).toBe("Write the notes.");
	});

	it("puts what this step already did last, closest to acting", () => {
		// Both blocks are context, so the question is which one an agent reads just
		// before it starts. What other steps did is background; what THIS step
		// already did is what stops it repeating an effect.
		const prompt = stepPrompt(
			"Write the notes.",
			handoverText([step(1, [turn("done")])], null),
			retakeText([[turn("got halfway")]], null),
		);

		expect(prompt.indexOf("What the steps before you did")).toBeLessThan(
			prompt.indexOf("You have run this step before"),
		);
	});
});

describe("what a step is told about its own earlier attempts", () => {
	const wrote = (path: string, bytes = 10) => ({
		kind: "artifact.created",
		payload: { path, bytes },
	});
	const ended = (status: string, reason?: string) => ({
		kind: "persona.session.ended",
		payload: reason === undefined ? { status } : { status, reason },
	});

	it("says nothing at all on a step that has not run before", () => {
		// Which is nearly every step. A first attempt told "you have run this 0
		// times" is being handed a puzzle instead of a task, the same reason the
		// handover is null for the first step of a run.
		expect(retakeText([], "/w")).toBe(null);
	});

	it("says the earlier attempt is over rather than something to carry on from", () => {
		// `loadSession` is false and says why: a session that ended cannot be
		// resumed. An agent that assumed otherwise would carry on mid-thought from
		// a session that no longer exists.
		const text = retakeText([[turn("got halfway")]], null)!;

		expect(text).toContain("You have run this step before, once.");
		expect(text).toContain("new attempt and not a continuation");
	});

	it("counts the attempts", () => {
		expect(retakeText([[turn("one")], [turn("two")], [turn("three")]], null)).toContain(
			"before, 3 times",
		);
	});

	it("names every file any attempt wrote, not only the last one's", () => {
		// What was WRITTEN accumulates: attempt one may have written the file that
		// attempt two never reached, and it is still sitting in the folder.
		const text = retakeText([[wrote("first.md")], [wrote("second.md")]], null)!;

		expect(text).toContain("first.md");
		expect(text).toContain("second.md");
	});

	it("counts a file two attempts both wrote as one file", () => {
		const text = retakeText([[wrote("notes.md")], [wrote("notes.md")]], null)!;

		expect(text).toContain("Wrote notes.md.");
	});

	it("takes the words from the most recent attempt only", () => {
		// What was SAID does not accumulate. The newest note and the newest ending
		// are the current word on this step; the older ones are a transcript of
		// failed guesses that would push the instruction out of sight.
		const text = retakeText(
			[
				[turn("first guess"), ended("failed", "the tool was missing")],
				[turn("second guess"), ended("failed", "the machine restarted")],
			],
			null,
		)!;

		expect(text).toContain("second guess");
		expect(text).toContain("the machine restarted");
		expect(text).not.toContain("first guess");
		expect(text).not.toContain("the tool was missing");
	});

	it("says how it ended, with the status when there is no reason", () => {
		expect(retakeText([[ended("orphaned")]], null)).toContain("How it ended: orphaned");
		expect(retakeText([[ended("failed", "no host installed")]], null)).toContain(
			"failed: no host installed",
		);
	});

	it("says what it does not know instead of leaving a gap", () => {
		// A run killed with its machine leaves a record with no note, no ending and
		// no files. Three blank lines would read as three facts.
		const text = retakeText([[]], "/w")!;

		expect(text).toContain("What it said when it finished: nothing.");
		expect(text).toContain("How it ended: it did not say.");
		expect(text).toContain("What it left behind: no files.");
	});

	it("survives a record shaped wrong instead of throwing", () => {
		// Written by a daemon on somebody else's machine. A malformed event loses a
		// line, never the attempt it appears in.
		const text = retakeText(
			[
				[
					{ kind: "persona.session.ended", payload: null },
					{ kind: "persona.session.ended", payload: { status: 7 } },
					{ kind: "persona.session.ended", payload: { status: "  " } },
					{ kind: "artifact.created", payload: { path: "" } },
				],
			],
			null,
		)!;

		expect(text).toContain("How it ended: it did not say.");
		expect(text).toContain("What it left behind: no files.");
	});

	it("takes the last ending in a record and not the first", () => {
		// A record with two endings is a run that was sealed twice, which the room
		// refuses now. If one ever slips through, the one that stuck is the later.
		const text = retakeText([[ended("failed", "first seal"), ended("stopped", "second seal")]], null)!;

		expect(text).toContain("second seal");
		expect(text).not.toContain("first seal");
	});

	it("cuts a reason that would swallow the prompt", () => {
		const text = retakeText([[ended("failed", "x".repeat(2_000))]], null)!;

		expect(text.length).toBeLessThan(1_500);
		expect(text).toContain("…");
	});

	it("points at the folder, which is where the work actually is", () => {
		expect(retakeText([[turn("did some")]], "/home/mara/acme")).toContain(
			"That work is in /home/mara/acme, which is where you are.",
		);
		// A workspace with no folder set still gets a true sentence.
		expect(retakeText([[turn("did some")]], null)).toContain("the folder you are in");
	});

	it("tells the agent to check before redoing, which is the whole point", () => {
		// Nothing here dedupes a tool call: reading a file twice is fine and sending
		// a message twice is not, and only the agent about to do it can tell them
		// apart. So the block makes the repeat visible to that party.
		const text = retakeText([[turn("half done")]], "/w")!;

		expect(text).toContain("Check it before you redo it.");
		expect(text).toContain("happens again if you repeat it");
	});
});

describe("the files a step left behind", () => {
	it("reads them from the record rather than a row", () => {
		// Derived, the same rule the note follows: a copy in a row is a second place
		// the same fact lives, and the day the two disagree the one people believe is
		// the copy, because it is the one on screen.
		const files = producedFrom([
			{ kind: "agent.turn.ended", payload: { summary: "done" } },
			{ kind: "artifact.created", payload: { path: "notes/brief.md", bytes: 4812 } },
			{ kind: "artifact.created", payload: { path: "out.json", bytes: 12 } },
		]);

		expect(files).toEqual([
			{ path: "notes/brief.md", bytes: 4812 },
			{ path: "out.json", bytes: 12 },
		]);
	});

	it("counts a file written twice as one file", () => {
		// A step that rewrites the same file produced one file, and the size that
		// matters is the one it ended at.
		const files = producedFrom([
			{ kind: "artifact.created", payload: { path: "notes.md", bytes: 10 } },
			{ kind: "artifact.created", payload: { path: "notes.md", bytes: 40 } },
		]);

		expect(files).toEqual([{ path: "notes.md", bytes: 40 }]);
	});

	it("ignores an event with no usable path", () => {
		// The record is written by a daemon on somebody else's machine. A malformed
		// event loses a filename rather than the delivery it appears in.
		expect(
			producedFrom([
				{ kind: "artifact.created", payload: { bytes: 10 } },
				{ kind: "artifact.created", payload: { path: "   ", bytes: 10 } },
				{ kind: "artifact.created", payload: null },
			]),
		).toEqual([]);
	});

	it("says nothing when the step wrote nothing", () => {
		// A real outcome: a step that only read and reported leaves no file, and a
		// line saying "0 files" reads as a failure rather than as an answer.
		expect(describeProduced([])).toBe(null);
	});

	it("names one file, and counts a lot of them", () => {
		expect(describeProduced([{ path: "brief.md", bytes: 1 }])).toBe("Wrote brief.md.");

		const many = Array.from({ length: 14 }, (_, index) => ({
			path: `file-${index}.txt`,
			bytes: 1,
		}));
		const said = describeProduced(many) ?? "";

		expect(said).toContain("Wrote 14 files");
		expect(said).toContain("and 4 more");
		// A delivery listing fourteen filenames is a delivery nobody reads.
		expect(said).not.toContain("file-10.txt");
	});
});
