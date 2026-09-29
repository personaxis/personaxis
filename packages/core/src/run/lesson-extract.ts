/**
 * E88: asking the persona what it learned, with its own model.
 *
 * ## Why this is its own module
 *
 * The pure half (`run/lesson.ts`) holds the instruction and the reading of the reply, so both can be checked
 * without a model. The call has to live somewhere that may reach the network, and it lived inside
 * `runner-for.ts` at first, which made it an export nothing outside its own module reached: exactly what the
 * `designed-not-connected` sweep counts, and it caught it on 2026-09-16.
 *
 * Moving it here is not a way around that sweep, it is the fix the sweep asks for: `runner-for.ts` imports it
 * like any other piece it assembles, the way it already imports `colleagues` and `wordless`. The
 * alternative, making it private, would have meant deleting its test or asserting it through a path that
 * cannot see whether the question carried the work.
 *
 * ## What it refuses to do
 *
 * Null on anything that is not a readable lesson, including the persona answering that the method is not
 * worth keeping. Never a guess: a skill invented by the runtime and filed under the persona's name is durable
 * and nobody reading it later could tell it was not the persona's.
 */

import type { AgentOptions } from "../agent.js";
import type { Lesson, PostmortemInput } from "../postmortem.js";
import { requestToolCall } from "../tool-calling.js";
import { LESSON_INSTRUCTION, parseLesson } from "./lesson.js";

/**
 * The extractor a run is given, closed over the persona's own model.
 *
 * The persona's model and not a separate one, like the judge beside it in `agentOptionsFor`: a lesson
 * abstracted by a model the persona never declared would be written into its folder as a skill it wrote, and
 * its document cannot support that claim.
 */
export function lessonFrom(llm: AgentOptions["llm"]): (input: PostmortemInput) => Promise<Lesson | null> {
	return async (input) => {
		const asked = [
			{ role: "user" as const, content: `# What was asked\n${input.task}\n\n# How it went\n${input.transcript}` },
			{ role: "system" as const, content: LESSON_INSTRUCTION },
		];
		// No tools: this is one short question about method, and a catalogue here would invite the model to go
		// and do more work instead of answering it.
		// E147: and without thinking, where the destination has a switch. Read raw on 2026-09-29 with Qwen 3.5: this
		// question thought for 1.650 to 4.096 tokens and ran to the ceiling with no answer 3 times in 17; without
		// thinking it answered every time in about 160. It is one short JSON object about a method already used.
		const said = await requestToolCall({ ...llm, thinking: "off" }, asked, []);
		const read = parseLesson(said.text);
		return read.ok ? read.lesson : null;
	};
}
