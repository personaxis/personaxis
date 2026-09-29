/**
 * E88: what a persona asks itself after a hard-won piece of work, and how the answer is read.
 *
 * ## Why this is a module and not a call
 *
 * The same shape as `E83`'s decision step, and for the same reason: the instruction and the reading of the
 * reply are pure, so both can be checked without a model, and the call itself happens where calls already
 * happen. A module that reached for the network would be a module nobody can test without one.
 *
 * ## What it refuses to do
 *
 * It does not guess. A reply that cannot be read leaves the run without a lesson and says why, exactly as a
 * route that is not a route leaves the turn without one. The reason is not tidiness: a lesson the runtime
 * invented, written into the persona's own folder as a skill it wrote, is the forgery the author invariant
 * exists to prevent, and it would be durable.
 *
 * It also refuses the lesson that is only this task done again. A skill is a method, and "the method" for a
 * job that happens once is a note about that job: `reusable` is asked of the model on purpose, and a reply
 * that says no leaves nothing behind.
 */

// The lesson's shape is `postmortem.ts`'s, not a second one declared here. It is what `deps.extract` promises
// and what becomes the skill draft without a translation in between, so two types with one name and one
// meaning would be the duplicate this repository keeps finding: compatible today, divergent the first time
// somebody adds a field to one of them.
import type { Lesson } from "../postmortem.js";
import { repairToolArgs } from "../tool-repair.js";

export type { Lesson };

export type LessonRead =
	| { readonly ok: true; readonly lesson: Lesson }
	| { readonly ok: false; readonly error: string };

/** How long the parts may be, so one long-winded reply cannot write a skill nobody will read. */
const LIMITS = { name: 60, description: 200, body: 4000, list: 12 } as const;

/**
 * What the persona is asked, once, after a run that was hard and worked.
 *
 * Written as a question about METHOD rather than about the task, because the thing worth keeping is what would
 * help next time and not what happened this time. The `reusable` field is first so the easy answer is the
 * honest one: a model that has nothing general to say can say so in one word instead of inventing a skill.
 */
export const LESSON_INSTRUCTION = [
	"That worked, and it was not trivial. Before you finish, decide whether the METHOD you used is worth keeping for next time.",
	"Reply with ONLY one JSON object, no prose and no code fence:",
	// E148: the body as a LIST of steps. It was `"body": "<the method, in steps>"`, quoted like a text while asking for
	// steps, and Qwen 3.5 wrote the list anyway and closed it `]"}`, with the template's quote left over: 8 replies in
	// 20 could not be read (2026-09-29).
	'{"reusable": true|false, "name": "<short-name>", "description": "<one line, when it applies>", "capabilities": ["<what it is for>"], "allowed_tools": ["<tool>"], "body": ["<step>", "<step>"]}',
	"Say false when the only lesson is this task done again: a method that fits one job is a note about that job, not a skill.",
	"The body is instructions to your future self, in steps, with the numbers and names that mattered. Do not retell what happened.",
].join("\n");

/** One list of short strings, trimmed and capped, from whatever the model put there. */
function listOf(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter(Boolean)
		.slice(0, LIMITS.list);
}

/**
 * E147: the method, as text or as the list of steps the instruction asks for.
 *
 * The instruction says "the method, in steps", and a model that takes that literally answers with a list. Read raw
 * on 2026-09-29 from Qwen 3.5: `"body": ["Run check_page to observe the crash...", "Read the file to locate the
 * line...", "Edit the file to replace the undefined variable name with the correct state.property reference.", ...]`,
 * and this read only text, so a good method was thrown away as "no method in it". A list is written as numbered
 * steps; a list with no text in it is still no method.
 */
function methodOf(value: unknown): string {
	if (typeof value === "string") return value.trim().slice(0, LIMITS.body);
	if (!Array.isArray(value)) return "";
	const steps = value
		.filter((step): step is string => typeof step === "string")
		.map((step) => step.trim())
		.filter(Boolean);
	return steps.map((step, index) => `${index + 1}. ${step}`).join("\n").slice(0, LIMITS.body);
}

/**
 * The lesson out of whatever the model said.
 *
 * Tolerant about packaging, because a fence or a sentence around the object is a formatting slip and not a
 * different answer. Strict about substance: without a name and a body there is no method to keep, and writing
 * a skill out of a reply that carried neither would be the runtime authoring it.
 */
export function parseLesson(raw: string): LessonRead {
	const text = String(raw ?? "").trim();
	if (!text) return { ok: false, error: "the reply was empty" };

	const start = text.indexOf("{");
	if (start === -1) return { ok: false, error: "the reply held no JSON object" };
	const end = text.lastIndexOf("}");

	// E148: an object the model left open (the last brace forgotten) is read through the repair the tool calls
	// already use (`FR.10`), which closes what is open and invents nothing. Packaging, like the fence above.
	let parsed: unknown;
	try {
		if (end <= start) throw new Error("open");
		parsed = JSON.parse(text.slice(start, end + 1));
	} catch {
		const repaired = repairToolArgs(text.slice(start));
		if (!repaired.ok || !repaired.value) {
			return { ok: false, error: end <= start ? "the reply held no JSON object" : "the JSON object could not be read" };
		}
		parsed = repaired.value;
	}

	const record = (parsed ?? {}) as Record<string, unknown>;

	// Asked and answered: only an explicit yes writes anything. Absent is not yes, because a model that never
	// considered the question should not leave a skill behind by omission.
	if (record.reusable !== true) return { ok: false, error: "the persona said the method was not worth keeping" };

	const name = typeof record.name === "string" ? record.name.trim().slice(0, LIMITS.name) : "";
	const body = methodOf(record.body);
	if (!name) return { ok: false, error: "the lesson had no name" };
	if (!body) return { ok: false, error: "the lesson had no method in it" };

	return {
		ok: true,
		lesson: {
			name,
			description: typeof record.description === "string" ? record.description.replace(/\s+/g, " ").trim().slice(0, LIMITS.description) : "",
			capabilities: listOf(record.capabilities),
			// `allowed_tools` in the reply, because that is the field name a skill file uses and asking the model
			// for two spellings of one idea is how a field ends up empty half the time.
			allowedTools: listOf(record.allowed_tools),
			body,
		},
	};
}
