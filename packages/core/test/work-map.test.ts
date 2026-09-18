/**
 * E79: the work map. What a persona has, what each thing is for, and where work goes.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderWorkMap, workMapFor } from "../src/run/work-map.js";

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
			{ address: "game-build", name: "Game build", about: "A design and a playable prototype that agree.", delivers: ["GAME.md", "game.html"], steps: 2 },
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
