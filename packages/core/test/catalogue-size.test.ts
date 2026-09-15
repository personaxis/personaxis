/**
 * C8: ten focused tools beat fifty overlapping ones.
 *
 * The reference has 129 tool files. The phase this belongs to opens by saying the
 * distance is not closed by writing 123 more, and this is where that stops being a
 * sentence in a plan: **the catalogue a persona sees has a ceiling, and adding to it is
 * a decision somebody writes down** rather than a file somebody drops in.
 *
 * The argument is not tidiness. A model picks a tool by reading names and descriptions,
 * so two tools that overlap are two tools it has to choose between with no way to be
 * right, and the cost lands as a wrong call it then has to recover from. If an engineer
 * cannot say which of two tools to use, the model cannot either.
 *
 * ## What this counts, and what it deliberately does not
 *
 * What WE ship: the built-ins, the two memory readers, delegation, and the one the loop
 * adds when it is subsetting. Every one of those is our decision.
 *
 * NOT what a person mounts. An MCP server's tools are unbounded by design and are the
 * user's own choice about their own machine; a ceiling on those would be this package
 * telling somebody how many tools their GitHub server may have.
 *
 * MEASURED on 2026-09-08: 7 built-ins, 4 more from the three other sources, and zero
 * pairs sharing a first sentence. The numbers below are those, not round figures.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TOOLS } from "../src/tools/registry.js";
import { FIND_TOOLS_TOOL } from "../src/tools/find-tools.js";
import { memoryTools } from "../src/memory/retrieval.js";
import { delegateTool } from "../src/tools/delegate.js";
import { UPDATE_TASKS_TOOL } from "../src/tools/update-tasks.js";
import { USE_SKILL_TOOL } from "../src/tools/use-skill.js";
import { ASK_PERSON_TOOL } from "../src/tools/ask-person.js";
import { readMemoryKnobs } from "../src/memory/knobs.js";

/**
 * Everything this package can put in front of a model, derived rather than listed.
 *
 * A written list would be a second place the truth lives, and the day somebody adds a
 * tool without touching it, the gate would pass while the catalogue grew.
 */
function everythingWeShip(): string[] {
	const persona = join(mkdtempSync(join(tmpdir(), "pxs-catalogue-")), "persona.md");
	const memory = memoryTools(persona, readMemoryKnobs({}));
	const delegation = delegateTool({
		run: async () => ({ answer: "", stopReason: "finished", steps: 0 }),
		depth: () => 0,
		scope: () => ({}),
	});

	return [
		...TOOLS.map((tool) => tool.name),
		...memory.map((tool) => tool.name),
		delegation.name,
		FIND_TOOLS_TOOL,
		// E72: mounted by `runnerFor` for a persona with skills, so it came from a fifth source this list
		// did not read, and the ceiling stayed at eleven while the catalogue was twelve. Counted now.
		USE_SKILL_TOOL,
		// E81: the persona's own task list, offered on every run.
		UPDATE_TASKS_TOOL,
		// E84: a question to the person, offered on every run.
		ASK_PERSON_TOOL,
	];
}

describe("how many tools a persona can be shown", () => {
	it("is fourteen, and one more is a decision rather than a file somebody added", () => {
		// Raise this number in the same commit as the tool, with the reason in the
		// commit message. That is the whole mechanism: it costs one line and it makes
		// the next tool something a person chose.
		//
		// Twelve and thirteen, 2026-09-15: `use_skill` (E72), which loads a skill by name because counting
		// words chose the wrong ones, and `update_tasks` (E81), because a small model loses steps when its
		// plan lives only in the conversation. Neither overlaps another: one reads a method, one keeps a list.
		//
		// Fourteen, 2026-09-15: `ask_person` (E84), because a persona missing what only a person can give either
		// invented it or stopped in prose nothing could read as a question. It overlaps nothing: no other tool
		// reaches a person, and a request for approval is the gate's question about a call, not the persona's.
		expect(everythingWeShip()).toHaveLength(14);
	});

	it("counts seven built-ins, which is the half a plugin cannot change", () => {
		expect(TOOLS).toHaveLength(7);
	});

	it("names each of them once", () => {
		// A repeated name is a coin flip about which code runs, and the model picks by
		// name. `mountBuiltins` already refuses this at mount; asserted here too because
		// the catalogue is assembled from four sources and only one of them goes through
		// that check.
		const names = everythingWeShip();

		expect(new Set(names).size).toBe(names.length);
	});
});

describe("how a model tells two tools apart", () => {
	it("gives no two tools the same first sentence", () => {
		// The line a model reads first. Two tools that open identically are two tools it
		// has to choose between on the strength of what comes after, which is where
		// descriptions get vague.
		const firsts = TOOLS.map((tool) => tool.description.split(/[.\n]/)[0]?.trim().toLowerCase());

		expect(new Set(firsts).size).toBe(firsts.length);
	});

	it("says enough about each one to choose it", () => {
		// Forty characters, which the shortest today clears at 54: a floor that catches
		// a name repeated as a description, not a style rule about prose. Research the
		// MCP server's own header cites says description quality is the main driver of
		// correct tool selection, so this is the cheap end of the thing that matters
		// most.
		const thin = TOOLS.filter((tool) => tool.description.length < 40).map((tool) => tool.name);

		expect(thin).toEqual([]);
	});
});
