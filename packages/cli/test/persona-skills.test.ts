/**
 * From the skills a persona declares to the skills its loop is given.
 *
 * Added 2026-09-11: `extensions.skills` had a door out (compile materialises them for a host) and
 * no door in, so our own loop ran a persona with three skills exactly like one with none.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { personaSkills } from "../src/workspace/persona-skills.js";

describe("the skills a persona brings to its loop", () => {
	let dir: string;
	const persona = () => join(dir, "personaxis.md");
	const skill = (name: string, body: string): void => {
		mkdirSync(join(dir, "skills", name), { recursive: true });
		writeFileSync(join(dir, "skills", name, "SKILL.md"), body);
	};

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pxs-skills-"));
		writeFileSync(persona(), "---\n---\n");
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("brings none when the persona declares none", () => {
		const { skills, skillGuides } = personaSkills(persona(), {});
		expect(skills).toEqual([]);
		expect(skillGuides.size).toBe(0);
	});

	it("reads a local skill's guide whole, and its description as what it is good at", () => {
		skill("game-feel", "---\nname: game-feel\ndescription: Make a game's actions feel responsive and readable.\n---\n\n# Game feel\n\nScreen shake decays.\n");
		const { skills, skillGuides } = personaSkills(persona(), { extensions: { skills: ["./skills/game-feel"] } });
		expect(skills).toHaveLength(1);
		expect(skills[0]!.name).toBe("game-feel");
		// Its own name, the halves of its name, and the words of its description.
		expect(skills[0]!.capabilities).toContain("game-feel");
		expect(skills[0]!.capabilities).toContain("game");
		expect(skills[0]!.capabilities).toContain("responsive");
		expect(skillGuides.get("game-feel")?.guide).toContain("Screen shake decays.");
		expect(skillGuides.get("game-feel")?.source).toBe("local:game-feel");
	});

	it("declares no tools when the skill names none, which is what stops it narrowing the catalog", () => {
		skill("quiet", "---\nname: quiet\ndescription: Says nothing about tools.\n---\n\nbody\n");
		const { skills } = personaSkills(persona(), { extensions: { skills: ["./skills/quiet"] } });
		expect(skills[0]!.allowedTools).toEqual([]);
	});

	it("reads allowed-tools when the skill names them, in either spelling and either shape", () => {
		skill("fs", "---\nname: fs\ndescription: Files.\nallowed-tools: read_file, write_file\n---\nbody\n");
		skill("sh", '---\nname: sh\ndescription: Shell.\nallowed_tools: ["run_command"]\n---\nbody\n');
		const { skills } = personaSkills(persona(), { extensions: { skills: ["./skills/fs", "./skills/sh"] } });
		expect(skills.find((s) => s.name === "fs")?.allowedTools).toEqual(["read_file", "write_file"]);
		expect(skills.find((s) => s.name === "sh")?.allowedTools).toEqual(["run_command"]);
	});

	it("skips a declared skill whose SKILL.md is not on the disk, rather than inventing one", () => {
		const { skills } = personaSkills(persona(), { extensions: { skills: ["./skills/absent"] } });
		expect(skills).toEqual([]);
	});

	it("does not fetch a github or registry skill: pulling one is its own command, with its review", () => {
		skill("local", "---\nname: local\ndescription: Here.\n---\nbody\n");
		const { skills } = personaSkills(persona(), {
			extensions: { skills: ["./skills/local", "github:someone/skills", "@org/thing@1.0.0"] },
		});
		expect(skills.map((s) => s.name)).toEqual(["local"]);
	});
});
