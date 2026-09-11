/**
 * From the skills a persona declares to the skills its running loop is actually given.
 *
 * `extensions.skills` has existed in the spec since the beginning, and `compile` materialises the
 * local ones into the host's discovery directory so Claude Code or Codex can find them. What was
 * missing is the door in the other direction: when OUR loop runs the persona, the agent takes
 * `skills` and `skillGuides` (J.2, J.2c) and nothing was computing them, so a persona with three
 * skills ran exactly like a persona with none. Found on 2026-09-11 wiring the game-designer demo.
 *
 * What a guide is, and what it is not: a `SKILL.md` is text the persona did not write, so it is
 * delivered as quoted reference material in its own system message, which is what `skill-guide.ts`
 * does. Nothing here changes that; this only finds the files and hands them over.
 *
 * Only LOCAL skills are read. A `github:` or registry reference is a pointer to something not on
 * this disk, and the run does not fetch it: pulling a skill is `personaxis skills`, with its review.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { ActiveSkill, SkillGuide } from "@personaxis/core";

import { resolveDeclaredSkills, type DeclaredSkill } from "../targets/skills.js";

/** What the loop needs: which skills exist, and the guide of each. */
export interface PersonaSkills {
	skills: ActiveSkill[];
	skillGuides: Map<string, SkillGuide>;
}

/** The `name:`, `description:` and `allowed-tools:` of a SKILL.md, read without a YAML parser. */
function frontmatterOf(body: string): { description: string; allowedTools: string[] } {
	const text = body.replace(/\r\n/g, "\n");
	if (!text.startsWith("---\n")) return { description: "", allowedTools: [] };
	const close = text.indexOf("\n---", 4);
	if (close < 0) return { description: "", allowedTools: [] };
	const head = text.slice(4, close);
	const field = (key: string): string => {
		const m = new RegExp(`^${key}:\\s*(.*)$`, "mi").exec(head);
		return m ? m[1]!.trim().replace(/^["']|["']$/g, "") : "";
	};
	const tools = field("allowed-tools") || field("allowed_tools");
	return {
		description: field("description"),
		allowedTools: tools
			? tools.replace(/^\[|\]$/g, "").split(",").map((t) => t.trim().replace(/^["']|["']$/g, "")).filter(Boolean)
			: [],
	};
}

/**
 * What a skill claims to be good at, for matching against a task.
 *
 * The skill's own name and the words of its description, which is the field a SKILL.md is required
 * to have and the one written to say when to use the skill. Matching is `activeSkillsFor`'s job.
 */
function capabilitiesOf(skill: DeclaredSkill, description: string): string[] {
	const words = `${skill.name} ${description}`.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
	return [...new Set([skill.name.toLowerCase(), ...skill.name.toLowerCase().split("-"), ...words])];
}

/**
 * The persona's local skills and their guides, or empty when it declares none.
 *
 * `personaPath` is the persona's own `personaxis.md`; skills live beside it, under `skills/<name>/`.
 */
export function personaSkills(personaPath: string, frontmatter: Record<string, unknown>): PersonaSkills {
	const baseDir = dirname(resolve(personaPath));
	const declared = resolveDeclaredSkills(frontmatter as never, baseDir);
	const skills: ActiveSkill[] = [];
	const skillGuides = new Map<string, SkillGuide>();

	for (const skill of declared) {
		if (skill.kind !== "local" || !skill.sourceDir) continue;
		const file = join(skill.sourceDir, "SKILL.md");
		if (!existsSync(file)) continue;
		let body: string;
		try {
			body = readFileSync(file, "utf-8");
		} catch {
			continue;
		}
		const { description, allowedTools } = frontmatterOf(body);
		skills.push({ name: skill.name, capabilities: capabilitiesOf(skill, description), allowedTools });
		// The source is recorded so a reader of the transcript can see where the text came from.
		skillGuides.set(skill.name, { name: skill.name, guide: body, source: `local:${skill.name}` });
	}

	return { skills, skillGuides };
}
