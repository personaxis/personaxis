/**
 * E72: a persona loads its own skills by name, and nothing chooses them for it by counting words.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Kernel } from "../src/kernel/index.js";
import { localExecution } from "../src/ports/execution.js";
import { localSkillsOf } from "../src/run/local-skills.js";
import { runnerFor } from "../src/run/runner-for.js";
import type { Policy } from "../src/sandbox.js";
import { TOOL_POINT } from "../src/tools/mounted.js";
import { useSkillTool } from "../src/tools/use-skill.js";

let workspace: string;
let personaPath: string;

function write(path: string, text: string): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, text);
}

beforeEach(() => {
	workspace = mkdtempSync(join(tmpdir(), "pxs-use-skill-"));
	const folder = join(workspace, ".personaxis", "personas", "gamewright");
	personaPath = join(folder, "personaxis.md");
	write(personaPath, '---\nextensions:\n  skills:\n    - "./skills/game-feel"\n    - "./skills/playable-prototype"\n---\n');
	write(
		join(folder, "skills", "game-feel", "SKILL.md"),
		"---\nname: game-feel\ndescription: Make a game's actions feel responsive.\n---\n\n# Game feel\n\nFix the core interaction before adding juice. Start hit-stop at 60 ms.\n",
	);
	write(join(folder, "skills", "game-feel", "tuning-table.md"), "# Tuning table\n");
	write(join(folder, "skills", "playable-prototype", "SKILL.md"), "---\nname: playable-prototype\ndescription: Build a game that runs.\n---\n\nOne HTML file, no network.\n");
});

afterEach(() => {
	rmSync(workspace, { recursive: true, force: true });
});

const policy = (over: Partial<Policy> = {}): Policy => ({
	sandbox: "workspace-write",
	approval: "on-failure",
	allow: [],
	deny: [],
	workspaceRoot: workspace,
	...over,
});

const tool = () => useSkillTool({ skills: () => localSkillsOf(personaPath).skills });

describe("use_skill (E72)", () => {
	it("loads a skill's instructions as quoted material, with its version and the files that come with it", async () => {
		const out = await tool().execute({ name: "game-feel" }, policy(), localExecution());
		expect(out).toContain("Fix the core interaction before adding juice. Start hit-stop at 60 ms.");
		// Quoted and attributed: a skill is text the persona did not write, and it does not authorise.
		expect(out).toContain("```text");
		expect(out).toContain("NOT by you");
		expect(out).toMatch(/your skill, version sha256:[0-9a-f]{16}/);
		expect(out).toContain("tuning-table.md");
		expect(out).not.toContain("description: Make a game's actions feel responsive.");
	});

	it("finds a skill whatever the case of its name", async () => {
		const out = await tool().execute({ name: "Game-Feel" }, policy(), localExecution());
		expect(out).toContain("Start hit-stop at 60 ms.");
	});

	it("says which skills exist when asked for one that does not", async () => {
		const out = await tool().execute({ name: "level-design" }, policy(), localExecution());
		expect(out).toBe('error: you have no skill named "level-design". Your skills: game-feel, playable-prototype.');
	});

	it("reads a SKILL.md edited mid-session as it is now", async () => {
		const loader = tool();
		write(join(workspace, ".personaxis", "personas", "gamewright", "skills", "game-feel", "SKILL.md"), "---\nname: game-feel\n---\n\nRevised: start hit-stop at 40 ms.\n");
		expect(await loader.execute({ name: "game-feel" }, policy(), localExecution())).toContain("Revised: start hit-stop at 40 ms.");
	});

	it("crosses the gate as a read: allowed inside the workspace, asked for outside it", () => {
		expect(tool().gate({ name: "game-feel" }, policy()).decision).toBe("allow");
		const elsewhere = mkdtempSync(join(tmpdir(), "pxs-other-"));
		try {
			expect(tool().gate({ name: "game-feel" }, policy({ workspaceRoot: elsewhere })).decision).toBe("ask");
		} finally {
			rmSync(elsewhere, { recursive: true, force: true });
		}
	});

	it("declares that it writes nothing and reaches nothing", () => {
		const spec = tool();
		expect(spec.isReadOnly).toBe(true);
		expect(spec.envelope).toEqual([]);
	});
});

describe("the turn a persona is given offers use_skill (E72)", () => {
	const llm = { endpoint: "http://model.invalid", model: "m", apiKey: "k" } as never;
	const offered = (frontmatter: Record<string, unknown>, path = personaPath): string[] => {
		const kernel = new Kernel();
		runnerFor({ personaPath: path, frontmatter, llm }, { kernel });
		return kernel.extensions.of(TOOL_POINT).map((spec) => spec.name);
	};
	const declaring = { extensions: { skills: ["./skills/game-feel", "./skills/playable-prototype"] } };

	it("to a persona that has skills, whatever surface built the turn", () => {
		expect(offered(declaring)).toContain("use_skill");
	});

	it("to a read-only persona too, because loading a skill is reading", () => {
		expect(offered({ ...declaring, permissions: { sandbox: "read-only" } })).toContain("use_skill");
	});

	it("not to a persona with no skills on disk, where it could only ever say there are none", () => {
		expect(offered({ extensions: { skills: ["./skills/not-written-yet"] } })).not.toContain("use_skill");
		expect(offered({})).not.toContain("use_skill");
	});
});
