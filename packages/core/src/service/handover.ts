/**
 * What one step tells the next one.
 *
 * The piece without which a multi-step service is theatre. Until this existed the
 * second step got its own instruction and nothing else: it worked in the same
 * folder as the first, which is real, and had no idea what the first had done
 * there, which made "summarise what the Watcher left" an instruction the agent
 * could not follow.
 *
 * ## Two halves, and only one of them is text
 *
 * **The folder** is the durable half. Every step of a run works in the same
 * workspace directory, so a file the first step wrote is a file the second one
 * opens. That is what makes a handover survive three days of waiting for an
 * approval: nothing is held in a session.
 *
 * **The note** is the other half, and it is what the agent SAID when it finished.
 * The daemon reports each turn with a `summary`, which is the text the agent
 * produced; the last one of a session is its closing word. That is the note. It
 * is not generated, not summarised by a model, and not invented: if the agent
 * said nothing, the note says so and points at the folder.
 *
 * ## Derived from the record, never stored
 *
 * The record is what happened. A copy of the note on the job row would be a
 * second place the same fact lives, and the day they disagree the one people
 * trust is the copy, because it is the one on the screen. So this reads the
 * record every time a step starts, which is once per step and not once per view.
 *
 * ## Bounded, and it says when it cut
 *
 * A service may have twenty steps and an agent may write at length. An unbounded
 * handover is a prompt that grows until a model refuses it, and the failure lands
 * on the LAST step of a long service, which is the most expensive place to
 * discover it. So the newest notes are kept and the older ones are dropped with a
 * line saying how many, because a silent truncation is a lie about what the
 * previous steps did.
 */

/** One entry of a job's record, as much of it as this file reads. */
export interface RecordedTurn {
	kind: string;
	payload: unknown;
}

export interface PreviousStep {
	position: number;
	/** What the step was called, for the sentence. */
	name: string;
	personaName: string;
	/** That job's record, oldest first. */
	entries: readonly RecordedTurn[];
}

/**
 * How much of the handover reaches the prompt.
 *
 * Twelve thousand characters is a few pages: enough for several steps of real
 * prose, far short of any model's limit, and small enough that the instruction
 * still reads as the point of the message rather than a footnote to a transcript.
 */
const MAX_HANDOVER_CHARS = 12_000;

/** Per note, so one talkative step cannot crowd out the other five. */
const MAX_NOTE_CHARS = 3_000;

/**
 * The note a step left: the last thing its agent said.
 *
 * Null when it said nothing, which is a real outcome and not an error. A step
 * that only edited files leaves its work in the folder and no words behind, and
 * claiming otherwise would be inventing a summary nobody wrote.
 *
 * Exported for `delivery.ts`, which assembles the same notes for a person to
 * read rather than for the next step. One reader of the record, two audiences: a
 * second implementation would eventually disagree about which turn was the last
 * one, and the two would describe the same run differently.
 */
/** A file a step left in the workspace folder. Named, never carried. */
export interface ProducedFile {
	path: string;
	bytes: number;
}

/**
 * How many files one step's list will name.
 *
 * A step that ran a generator can touch a hundred, and a delivery listing a
 * hundred filenames is a delivery nobody reads. Past this the list says how many
 * more there were, which is the fact somebody actually needs.
 */
const MAX_FILES_LISTED = 10;

/**
 * The files a step left behind, from its record.
 *
 * Derived rather than stored, the same rule the note above follows: a copy in a
 * row would be a second place the same fact lives, and the day the two disagree
 * the one people believe is the copy, because it is the one on screen.
 *
 * The bytes are not here and never were. The daemon names what it wrote and
 * sends nothing, because the connected mode is sold on nothing leaving the
 * operator's machine. So this answers "what did it produce" and the answer to
 * "give it to me" stays "it is in your folder".
 *
 * Deduplicated by path, keeping the last size seen: a step that writes the same
 * file twice produced one file, and the size that matters is the one it ended at.
 */
export function producedFrom(entries: readonly RecordedTurn[]): ProducedFile[] {
	const byPath = new Map<string, ProducedFile>();

	for (const entry of entries) {
		if (entry.kind !== "artifact.created") continue;
		const payload = entry.payload as { path?: unknown; bytes?: unknown } | null;
		if (typeof payload?.path !== "string" || !payload.path.trim()) continue;

		byPath.set(payload.path, {
			path: payload.path,
			bytes: typeof payload.bytes === "number" && payload.bytes >= 0 ? payload.bytes : 0,
		});
	}

	return [...byPath.values()];
}

/**
 * That list, as the line a person reads.
 *
 * Null when the step wrote nothing, which is a real outcome: a step that only
 * read and reported leaves no file, and a line saying "0 files" reads as a
 * failure rather than as an answer.
 */
export function describeProduced(files: readonly ProducedFile[]): string | null {
	if (files.length === 0) return null;

	const shown = files.slice(0, MAX_FILES_LISTED).map((file) => file.path);
	const rest = files.length - shown.length;
	const tail = rest > 0 ? `, and ${rest} more` : "";

	return files.length === 1
		? `Wrote ${shown[0]}.`
		: `Wrote ${files.length} files: ${shown.join(", ")}${tail}.`;
}

/**
 * The kinds of entry the readers in this file actually consume.
 *
 * It lives next to them because the one bug this file has had was a query that
 * asked for fewer: `deliver.ts` filtered to turns alone and then asked
 * `producedFrom` what the step had written, so no delivery ever named a file
 * while every test of the pure half stayed green. Retyping a kind list at each
 * query is how the two halves drift; a name they share is how a narrowing
 * becomes visible.
 *
 * `persona.session.ended` is not in here. Only the retake reads it, and a
 * delivery or a room answer that pulled every ending in would be paying for rows
 * it never looks at.
 */
export const NOTE_AND_FILES = ["agent.turn.ended", "artifact.created"] as const;

/**
 * A record read newest first, back into the order things happened in.
 *
 * The rows come out of the database descending, and that is not a style choice:
 * every read here is capped, and a cap on an ascending read keeps the OLDEST
 * entries. The comment above the old query said "the note is the last one, so
 * the tail is what matters and the rest is weight" while the code took the head,
 * so a step with more turns than the cap handed over the note from its first two
 * hundred and called it its closing word. An ending is at the end by definition,
 * so reading the ending that way would have been worse: never present at all.
 *
 * Everything that reads a record here takes the LAST match as the current one,
 * so the order has to be put back before any of them see it.
 */
export function chronological(
	entries: readonly { kind: string; payload: unknown }[],
): RecordedTurn[] {
	return [...entries].reverse().map((entry) => ({ kind: entry.kind, payload: entry.payload }));
}

export function noteFrom(entries: readonly RecordedTurn[]): string | null {
	let note: string | null = null;

	for (const entry of entries) {
		if (entry.kind !== "agent.turn.ended") continue;
		const summary = (entry.payload as { summary?: unknown } | null)?.summary;
		if (typeof summary === "string" && summary.trim()) note = summary.trim();
	}

	if (!note) return null;
	return note.length > MAX_NOTE_CHARS
		? `${note.slice(0, MAX_NOTE_CHARS)}\n[…the rest of this note is in the run's record]`
		: note;
}

/**
 * One attempt at this step that has already run: its record, oldest first.
 *
 * An attempt IS its record. There is no attempt row anywhere and this is not the
 * place to invent one: a retry continues the run it failed in, so what marks an
 * attempt is a job at the same position, and what it did is in the record that
 * job wrote.
 */
export type EarlierAttempt = readonly RecordedTurn[];

/** A reason is a sentence, not a transcript. Past this it is cut and said so. */
const MAX_REASON_CHARS = 500;

/**
 * How an attempt ended, in its own words.
 *
 * Not exported: its only caller is the block below. `describeProduced` and
 * `noteFrom` are exported because the delivery a person reads uses them too, and
 * an export whose only consumer is a test is what `designed-not-connected`
 * catches.
 *
 * The LAST ending in the record, not the first. A record with two is a run that
 * was sealed twice, which the room now refuses, and if one ever slips through
 * the later one is the one that stuck.
 */
function endingFrom(entries: readonly RecordedTurn[]): string | null {
	let ending: string | null = null;

	for (const entry of entries) {
		if (entry.kind !== "persona.session.ended") continue;
		const payload = entry.payload as { status?: unknown; reason?: unknown } | null;
		const status = typeof payload?.status === "string" ? payload.status.trim() : "";
		if (!status) continue;

		const reason = typeof payload?.reason === "string" ? payload.reason.trim() : "";
		const said =
			reason.length > MAX_REASON_CHARS ? `${reason.slice(0, MAX_REASON_CHARS)}…` : reason;
		ending = said ? `${status}: ${said}` : status;
	}

	return ending;
}

/**
 * What you already did here, when this step has run before.
 *
 * The block exists because of the one path in the product that starts the same
 * step twice: a person retrying a failed run. That retry continues the run, at
 * the position it failed at, and until this existed the new agent was handed the
 * original instruction and nothing else. The steps BEFORE it were described to
 * it; its own earlier attempt was not, because the handover reads jobs strictly
 * before this position. So it started in a folder it had already worked in, with
 * no idea it had, and redid whatever it had done.
 *
 * ## It says it is a new attempt, because that is the part people get wrong
 *
 * Resuming here is a fresh turn with the context rebuilt from the record, never
 * the old agent picked back up: `loadSession` is false and says why. An agent
 * that assumed otherwise would carry on mid-thought from a session that no
 * longer exists. So the first thing this says is that the earlier attempt is
 * over and nothing was carried across.
 *
 * ## Files across every attempt, words from the last one
 *
 * The two halves are bounded differently on purpose. What was WRITTEN
 * accumulates, so the files come from all the attempts together and deduplicate
 * by path, because attempt one may have written the file that attempt two never
 * reached. What was SAID does not accumulate: the newest note and the newest
 * ending are the current word on this step, and older ones are a transcript of
 * failed guesses that would push the instruction out of sight.
 *
 * ## What it cannot promise
 *
 * That an effect happens once. Nothing here dedupes a tool call: an agent may
 * legitimately read the same file twice, and a mechanism that refused would
 * break the honest case to protect the rare one. What this does is make the
 * repeat visible to the only party that can tell "read it again" from "send it
 * again", which is the agent about to do it.
 */
export function retakeText(
	attempts: readonly EarlierAttempt[],
	workingDir: string | null,
): string | null {
	if (attempts.length === 0) return null;

	const last = attempts[attempts.length - 1] ?? [];
	const note = noteFrom(last);
	const ending = endingFrom(last);
	const wrote = describeProduced(producedFrom(attempts.flat()));

	const ordinal = attempts.length === 1 ? "once" : `${attempts.length} times`;

	return [
		"---",
		"",
		`You have run this step before, ${ordinal}. This is a new attempt and not a continuation:`,
		"the agent that ran it is gone, and nothing was carried across from it.",
		"",
		`What it said when it finished: ${note ?? "nothing. What it did is in the folder."}`,
		`How it ended: ${ending ?? "it did not say."}`,
		`What it left behind: ${wrote ?? "no files."}`,
		"",
		workingDir
			? `That work is in ${workingDir}, which is where you are.`
			: "That work is in the folder you are in.",
		"Check it before you redo it. Something already finished can be verified instead of",
		"repeated, and an effect that reached outside this folder happens again if you repeat it.",
	].join("\n");
}

/**
 * The handover block, or null when there is nothing to hand over.
 *
 * Null for the first step of a run, and that is why it returns null rather than
 * an empty section: a first step told "here is what came before: nothing" is
 * being handed a puzzle instead of a task.
 */
export function handoverText(
	previous: readonly PreviousStep[],
	workingDir: string | null,
): string | null {
	if (previous.length === 0) return null;

	const ordered = [...previous].sort((a, b) => a.position - b.position);

	const blocks = ordered.map((step) => {
		const note = noteFrom(step.entries);
		// The persona in brackets only when it adds something. A step called
		// "The Watcher" done by the persona "The Watcher" read as
		// "The Watcher (The Watcher)", which is a field doing two jobs showing
		// its working.
		const heading =
			step.name === step.personaName
				? `Step ${step.position}: ${step.name}`
				: `Step ${step.position}: ${step.name} (${step.personaName})`;

		return {
			position: step.position,
			text: [heading, note ?? "Left no note. What it did is in the folder."].join("\n"),
		};
	});

	// Newest first while trimming, then put back in order. What the next step
	// needs most is what just happened; what it can lose is the oldest.
	const kept: typeof blocks = [];
	let size = 0;
	for (const block of [...blocks].reverse()) {
		if (size + block.text.length > MAX_HANDOVER_CHARS) break;
		kept.push(block);
		size += block.text.length;
	}
	kept.reverse();

	const dropped = blocks.length - kept.length;

	return [
		"---",
		"",
		"What the steps before you did:",
		"",
		...(dropped > 0
			? [
					`[${dropped} earlier step(s) omitted here to keep this short. Their notes are in the run's record.]`,
					"",
				]
			: []),
		kept.map((block) => block.text).join("\n\n"),
		"",
		workingDir
			? `They worked in ${workingDir}, which is where you are. Anything they wrote is there.`
			: "They worked in the same folder you are in. Anything they wrote is there.",
	].join("\n");
}

/**
 * The whole prompt for a step: what to do, then what came before.
 *
 * The instruction goes FIRST and the handover second, which is the opposite of
 * how it reads chronologically and is deliberate: the instruction is what this
 * step is for, and an agent handed a transcript before a task treats the task as
 * a footnote to the transcript.
 *
 * The retake goes LAST, after the handover, and that order is a decision too.
 * Both are context, so the question is which one an agent should read closest to
 * acting: what other steps did is background, and what THIS step already did is
 * the thing that makes it redo work or repeat an effect. Chronology agrees, for
 * once: the earlier steps ran before this step's own earlier attempt did.
 */
export function stepPrompt(
	instruction: string,
	handover: string | null,
	retake: string | null = null,
): string {
	return [instruction, handover, retake].filter((part) => part !== null).join("\n\n");
}
