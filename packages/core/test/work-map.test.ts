/**
 * E79: the work map. What a persona has, what each thing is for, and where work goes.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderWorkMap, workMapFor } from "../src/run/work-map.js";
// E103: the tool names the map hands the model, taken from the tools that own them and not typed again here.
import { memoryTools } from "../src/memory/retrieval.js";
import { readFileTool } from "../src/tools/builtin/read-file.js";
import { DELEGATE_TOOL } from "../src/tools/delegate.js";
import { RUN_SERVICE_TOOL } from "../src/tools/run-service.js";
import { USE_SKILL_TOOL } from "../src/tools/use-skill.js";

let workspace: string;

beforeEach(() => {
	workspace = mkdtempSync(join(tmpdir(), "pxs-work-map-"));
});

afterEach(() => {
	rmSync(workspace, { recursive: true, force: true });
});

function write(path: string, text: string): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, text);
}

const spec = (skills: string[], purpose = "A general game designer.") =>
	`---\nidentity:\n  system_identity:\n    purpose: "${purpose}"\nextensions:\n  skills:\n${skills.map((s) => `    - "./skills/${s}"`).join("\n") || "    []"}\nmemory:\n  types:\n    episodic: true\n    semantic: true\n---\n`;

/** A sub-persona with two skills, a reference, an example, an asset, a sub-persona of its own and a service. */
function gameDesigner(): string {
	const folder = join(workspace, ".personaxis", "personas", "gamewright");
	const path = join(folder, "personaxis.md");
	write(path, spec(["game-feel", "playable-prototype", "not-written-yet"]));
	write(join(folder, "skills", "game-feel", "SKILL.md"), "---\nname: game-feel\ndescription: >-\n  Make a game's actions feel responsive.\n  Use when a game feels floaty.\n---\n\n# Game feel\n");
	write(join(folder, "skills", "playable-prototype", "SKILL.md"), "---\nname: playable-prototype\ndescription: Build a game that actually runs, as one HTML file.\n---\n");
	write(join(folder, "references", "web-research.md"), "# What was read on the web, and where it came from\n\nbody");
	write(join(folder, "examples", "cat-game.md"), "\n\nA finished design for a cat game.\n");
	write(join(folder, "assets", "sprite.png"), "binary");
	write(join(folder, "personas", "tester", "personaxis.md"), spec([], "Plays every build and reports what breaks."));
	write(
		join(workspace, ".personaxis", "services", "game-build.json"),
		JSON.stringify({ name: "Game build", description: "A design and a playable prototype that agree.", leadPersonaRef: "gamewright", steps: [{ position: 1, personaRef: "gamewright", produces: ["GAME.md"] }, { position: 2, personaRef: "gamewright", produces: ["game.html", "GAME.md"] }] }),
	);
	write(join(workspace, ".personaxis", "services", "audit.json"), JSON.stringify({ name: "Audit", leadPersonaRef: "auditor", steps: [{ position: 1, personaRef: "auditor", produces: ["AUDIT.md"] }] }));
	return path;
}

describe("the work map (E79)", () => {
	it("says what each skill is for, from its own SKILL.md, and names the one that is not on disk", () => {
		const map = workMapFor(gameDesigner(), { workspaceRoot: workspace });
		expect(map.skills).toEqual([
			{ name: "game-feel", about: "Make a game's actions feel responsive. Use when a game feels floaty." },
			{ name: "playable-prototype", about: "Build a game that actually runs, as one HTML file." },
		]);
		expect(map.missingSkills).toEqual(["not-written-yet"]);
	});

	it("lists the services a sub-persona takes part in, with what a run has to leave, and not the others", () => {
		const map = workMapFor(gameDesigner(), { workspaceRoot: workspace });
		expect(map.services).toEqual([
			{ address: "game-build", name: "Game build", about: "A design and a playable prototype that agree.", delivers: ["GAME.md", "game.html"], steps: 2, leads: true },
		]);
	});

	it("gives a main persona every service in the workspace", () => {
		const main = join(workspace, ".personaxis", "personaxis.md");
		gameDesigner();
		write(main, spec([]));
		expect(workMapFor(main, { workspaceRoot: workspace }).services.map((s) => s.address)).toEqual(["audit", "game-build"]);
	});

	it("says what each reference, example and asset is, and what each sub-persona is for", () => {
		const map = workMapFor(gameDesigner(), { workspaceRoot: workspace });
		expect(map.references).toEqual([{ name: ".personaxis/personas/gamewright/references/web-research.md", about: "What was read on the web, and where it came from" }]);
		expect(map.examples).toEqual([{ name: ".personaxis/personas/gamewright/examples/cat-game.md", about: "A finished design for a cat game." }]);
		expect(map.assets).toEqual([{ name: ".personaxis/personas/gamewright/assets/sprite.png", about: "png file" }]);
		expect(map.subPersonas).toEqual([{ name: "tester", about: "Plays every build and reports what breaks." }]);
		expect(map.memory).toEqual(["episodic", "semantic"]);
	});

	it("renders an index a model can act on, and says where work goes", () => {
		const text = renderWorkMap(workMapFor(gameDesigner(), { workspaceRoot: workspace }));
		expect(text).toContain("- game-feel: Make a game's actions feel responsive. Use when a game feels floaty. (.personaxis/personas/gamewright/skills/game-feel/SKILL.md)");
		expect(text).toContain("Declared but not on disk, so not available: not-written-yet.");
		// E72: the index tells the persona how to use a skill, not just that it exists.
		expect(text).toContain("load it with use_skill before doing the work");
		expect(text).toContain('- game-build ("Game build"): A design and a playable prototype that agree. 2 steps, leaves GAME.md, game.html.');
		expect(text).toContain("- @tester: Plays every build and reports what breaks.");
		expect(text).toContain("You keep: episodic, semantic.");
		expect(text).toContain("## Where things go");
		expect(text).toContain(`Work happens in the workspace, \`${workspace.replace(/\\/g, "/")}\``);
		expect(text).toContain("Your own folder is `.personaxis/personas/gamewright`");
		expect(text).not.toMatch(/sandbox|posture|approval/i);
	});

	/**
	 * E91: the references section has to say what the memory section says, or the files go unread.
	 *
	 * Measured 2026-09-18 with the autonomy bench: asked which sources its advice on game feel rested on, a
	 * persona with `references/web-research-2026-09-11.md` on disk answered that it had none. 0 of 6, two
	 * different models, same answer. It was shown the file every turn. Memory already promised "search it
	 * before saying you do not remember" and references promised nothing, so "I have no sources" was the
	 * references version of "I do not remember".
	 */
	it("tells the persona to read a reference before saying it does not know where its advice came from", () => {
		const text = renderWorkMap(workMapFor(gameDesigner(), { workspaceRoot: workspace }));

		expect(text).toContain("before saying you do not know where something of yours comes from");
		// And the same promise for memory is still there: this adds one, it does not move the other.
		expect(text).toContain("before saying you do not remember");
	});

	/**
	 * E103: a section that asks for an action names the tool that performs it, or the action does not happen.
	 *
	 * Measured 2026-09-21 over the 505 runs the autonomy bench has saved. The three sections that named their
	 * tool are the three that got used: `use_skill` 476 calls, `memory_search` 91, `run_service` 27. The two
	 * that asked in prose and named nothing are the two that did not: References was read only when a model
	 * worked out the tool for itself, and `delegate` was called 3 times in the whole bench, never by one of the
	 * two models. The proof that the wording is the cause and not the model: asked which sources its advice
	 * rested on, a model called `memory_search` and then answered that it had no sources, without opening the
	 * reference listed on the same screen. It obeyed the promise that named a tool and not the one that did not.
	 *
	 * Written as the rule and not as the two cases, and against each tool's real name, so a section added later
	 * without its tool fails here, and so does a tool renamed without its line in the map.
	 */
	it("names the tool for every section that asks the persona to do something", () => {
		const text = renderWorkMap(workMapFor(gameDesigner(), { workspaceRoot: workspace }), { canRunServices: true });
		const memorySearch = memoryTools(gameDesigner(), { maxItems: 20, useEmbeddings: false, useReranker: false })[0];
		const asksForAnAction: ReadonlyArray<readonly [string, string]> = [
			["### Skills", USE_SKILL_TOOL],
			["### Services you deliver", RUN_SERVICE_TOOL],
			["### References", readFileTool.name],
			["### Sub-personas you can hand work to", DELEGATE_TOOL],
			["### Memory", memorySearch?.name ?? "memory_search"],
		];

		for (const [heading, tool] of asksForAnAction) {
			const at = text.indexOf(heading);
			expect(at, `${heading} is not in the map`).toBeGreaterThan(-1);
			const next = text.indexOf("\n###", at + 1);
			const body = text.slice(at, next === -1 ? text.indexOf("\n## ", at + 1) : next);
			expect(body, `${heading} asks for an action and does not name ${tool}`).toContain(tool);
		}
	});

	/**
	 * E103: and the colleague section leads with handing the work over, not with reading.
	 *
	 * Its title said "you can hand work to" and its body offered only "you may read their files", so reading is
	 * what happened: asked for the one thing only its colleague knew how to do, a persona opened the colleague's
	 * folder and wrote the report itself, 3 of 3. The permission to read stays, behind the tool, as the qualifier
	 * it always was.
	 */
	it("offers the colleague the work before it offers their files", () => {
		const text = renderWorkMap(workMapFor(gameDesigner(), { workspaceRoot: workspace }));
		const body = text.slice(text.indexOf("### Sub-personas you can hand work to"));

		const handOver = body.indexOf(DELEGATE_TOOL);
		const read = body.indexOf("read their files");
		// Both found first: a missing tool gives -1, and -1 is less than everything, so an order check on its
		// own would pass on exactly the map this test exists to refuse.
		expect(handOver).toBeGreaterThan(-1);
		expect(read).toBeGreaterThan(-1);
		expect(handOver).toBeLessThan(read);
		expect(body).toContain("you never write them");
	});

	/**
	 * E108: the index line says what is inside a reference, not only what it is called.
	 *
	 * Measured 2026-09-22 with the autonomy bench, 0 of 6 across two models and six measurements. Asked which
	 * sources its advice on game feel and juice rested on, a persona answered that it had none, while holding a
	 * file with a section called "game feel juice screen shake hit pause principles". The question carried the
	 * words, the file carried the words, and the index line carried the file's title, which says where it came
	 * from and not what is in it.
	 */
	describe("what a reference covers (E108)", () => {
		const withSections = (body: string): string => {
			const folder = join(workspace, ".personaxis", "personas", "gamewright");
			write(join(folder, "personaxis.md"), spec([]));
			write(join(folder, "references", "web-research.md"), body);
			return join(folder, "personaxis.md");
		};

		it("keeps the sections a sentence of their own, and says whose they are", () => {
			const path = withSections("# What was read on the web\n\n### one topic\n\nbody\n");
			const line = renderWorkMap(workMapFor(path, { workspaceRoot: workspace })).split("\n").find((l) => l.includes("web-research.md")) ?? "";

			// Measured 2026-09-22: worded "Covers:" and run on into the title with no full stop, a persona
			// asked what it could do for a client answered with the file's topic list and stopped naming its
			// own service. The words have to say these are the file's sections, and the sentence has to end.
			expect(line).toContain("What was read on the web. Sections inside it: one topic.");
			expect(line).not.toContain("web Sections");
			expect(line).not.toContain("Covers:");
		});

		it("names the sections under the title, which is what the question has to match", () => {
			const path = withSections(
				"# What was read on the web, and where it came from\n\nSearched on 2026-09-11.\n\n### core loop game design principles\n\n- a link\n\n### game feel juice screen shake hit pause\n\n- another link\n",
			);
			const text = renderWorkMap(workMapFor(path, { workspaceRoot: workspace }));

			expect(text).toContain("What was read on the web, and where it came from");
			expect(text).toContain("game feel juice screen shake hit pause");
			expect(text).toContain("core loop game design principles");
		});

		it("leaves a file with no sections exactly as it was", () => {
			const path = withSections("# A single note\n\nJust a paragraph, no sections at all.\n");
			const text = renderWorkMap(workMapFor(path, { workspaceRoot: workspace }));

			expect(text).toContain("A single note");
			expect(text).not.toContain("Covers:");
		});

		it("does not repeat the title as though it were a section", () => {
			const path = withSections("# Only a title\n\n## Only a title\n\nbody\n");
			const text = renderWorkMap(workMapFor(path, { workspaceRoot: workspace }));
			const line = text.split("\n").find((l) => l.includes("web-research.md")) ?? "";

			// The title appears once as the description; the duplicate heading adds nothing after it.
			expect(line.match(/Only a title/g)).toHaveLength(1);
		});

		/**
		 * All of them or none, and this one cost a measurement to learn.
		 *
		 * The first version listed the first few and wrote "and N more" after them. Asked about game feel, a
		 * persona took the FIRST topic on that list, searched the file for it, and cited the sources of the
		 * wrong section; the one it needed was inside the "4 more". A partial list is read as the whole list,
		 * so it is worse than no list: it turns an index into a menu of wrong answers.
		 */
		it("lists every section or none, and never the first few", () => {
			const many = Array.from({ length: 40 }, (_, i) => `### section number ${i} with a fairly long title to push the budget\n\nbody\n`).join("\n");
			const path = withSections(`# A big reference\n\n${many}`);
			const line = renderWorkMap(workMapFor(path, { workspaceRoot: workspace })).split("\n").find((l) => l.includes("web-research.md")) ?? "";

			expect(line).not.toContain("Sections inside it:");
			expect(line).not.toContain("more");
			expect(line).toContain("A big reference");
			expect(line.length).toBeLessThan(300);
		});

		it("keeps the whole list when it fits, because the one that matters may be the last", () => {
			const eight = Array.from({ length: 8 }, (_, i) => `### topic ${i}\n\nbody\n`).join("\n");
			const path = withSections(`# A reference\n\n${eight}`);
			const line = renderWorkMap(workMapFor(path, { workspaceRoot: workspace })).split("\n").find((l) => l.includes("web-research.md")) ?? "";

			for (let i = 0; i < 8; i += 1) expect(line).toContain(`topic ${i}`);
			expect(line).not.toContain("more");
		});

		it("renders the same bytes twice, because the map sits in the cached prefix", () => {
			const path = withSections("# A reference\n\n### one\n\n### two\n");
			const first = renderWorkMap(workMapFor(path, { workspaceRoot: workspace }));
			const second = renderWorkMap(workMapFor(path, { workspaceRoot: workspace }));

			expect(second).toBe(first);
		});
	});

	it("does not move while a persona works: a new session file, memory or state change nothing", () => {
		const path = gameDesigner();
		const before = renderWorkMap(workMapFor(path, { workspaceRoot: workspace }));
		const folder = join(workspace, ".personaxis", "personas", "gamewright");
		write(join(folder, "sessions", "2026-09-14-first.jsonl"), "{}\n");
		write(join(folder, "memory", "episodic.jsonl"), "{}\n");
		write(join(folder, "state.json"), "{}");
		write(join(folder, "record.jsonl"), "{}\n");
		expect(renderWorkMap(workMapFor(path, { workspaceRoot: workspace }))).toBe(before);
	});

	it("caps a long section and counts what it left out instead of dropping it", () => {
		const folder = join(workspace, ".personaxis", "personas", "big");
		const names = Array.from({ length: 100 }, (_, i) => `skill-${String(i).padStart(3, "0")}`);
		write(join(folder, "personaxis.md"), spec(names));
		for (const name of names) write(join(folder, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: Does thing ${name}.\n---\n`);
		const text = renderWorkMap(workMapFor(join(folder, "personaxis.md"), { workspaceRoot: workspace }));
		const listed = text.split("\n").filter((line) => line.startsWith("- skill-"));
		expect(listed).toHaveLength(20);
		expect(text).toContain("- ...and 80 more in .personaxis/personas/big/skills/; list it when you need one.");
	});

	it("says so when a persona has nothing yet", () => {
		const path = join(workspace, ".personaxis", "personaxis.md");
		write(path, "---\n---\n");
		expect(renderWorkMap(workMapFor(path, { workspaceRoot: workspace }))).toContain("You have no skills, services, references, examples, assets or sub-personas yet.");
	});
});
