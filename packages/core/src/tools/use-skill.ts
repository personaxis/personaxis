/**
 * `use_skill`: a persona loads one of its own skills, by name, when a task fits it.
 *
 * ## Why this exists
 *
 * Measured on 2026-09-13 and 2026-09-14. Skills reached the loop through a selector that counted the
 * words a message shared with each skill's name and description. A step that said "game" activated all
 * three of a game designer's skills, a request about "a kitten crossing the street" activated none, and
 * the tool subset that came with them hid `check_page` from the one step written to use it. The
 * direction was set by the person who owns the product: a persona is spoken to in plain language and
 * decides for itself what it uses.
 *
 * This is how Agent Skills works. The model reads each skill's name and description in its index (the
 * work map), decides one applies, and loads the full instructions. Loading is a call, so it crosses the
 * gate like any read, and the call itself is the trace of which skill was used, in which turn, and the
 * version is named in what comes back.
 *
 * ## What it does not do
 *
 * It grants nothing. The instructions arrive as quoted material, attributed, saying they advise and do
 * not authorise (`skill-guide.ts`), and every call they lead to is gated on its own. A skill's
 * `allowed-tools` narrows nothing: a skill never takes a tool away from the persona that loaded it.
 */

import { relative } from "node:path";

import matter from "gray-matter";

import type { ExecutionPort } from "../ports/execution.js";
import { skillFingerprint, skillNamed, type LocalSkill } from "../run/local-skills.js";
import type { CommandVerdict, Policy } from "../sandbox.js";
import { renderGuides } from "../skill-guide.js";
import { READ_CLASS, readGate } from "./gates.js";
import type { ToolSpec } from "./registry.js";

/** The name the loop, the work map and the record (E80) all use. One owner, so a rename cannot half-happen. */
export const USE_SKILL_TOOL = "use_skill";

/**
 * How much of one loaded skill reaches the model.
 *
 * Larger than a guide shown unasked, because this one was asked for: the persona chose it for the task
 * in front of it. A skill longer than this is a document, and the rest stays readable by path.
 */
const MAX_LOADED_SKILL_CHARS = 12_000;

/** The files a listing names, without the skill's own `SKILL.md`. */
function supportingFiles(listing: string): string[] {
	return listing
		.split(/\r?\n/)
		.map((line) => line.trim().replace(/^[-*]\s+/, ""))
		.filter((name) => name.length > 0 && !/^SKILL\.md$/i.test(name) && !/^\(empty\)$/i.test(name));
}

export interface UseSkillToolOptions {
	/**
	 * The persona's skills, read when the tool is CALLED. A function and not a list, so a `SKILL.md`
	 * edited mid-session is loaded as it is now rather than as it was when the catalogue was built.
	 */
	readonly skills: () => readonly LocalSkill[];
}

export function useSkillTool(options: UseSkillToolOptions): ToolSpec {
	return {
		name: USE_SKILL_TOOL,
		category: "fs",
		description:
			"Load one of your skills by name: its full instructions and the files that come with it. " +
			"When a task fits a skill in your index, load it before doing the work, then follow it within your own limits.",
		parameters: {
			type: "object",
			additionalProperties: false,
			required: ["name"],
			properties: {
				name: { type: "string", description: "The skill's name, exactly as your index lists it." },
			},
		},
		isReadOnly: true,
		isConcurrencySafe: true,
		// Reading its own instructions writes nothing and reaches nothing outside the folder.
		envelope: [],
		gate: (args: Record<string, unknown>, policy: Policy): CommandVerdict => {
			const skill = typeof args.name === "string" ? skillNamed(options.skills(), args.name) : undefined;
			// A name that matches nothing reads nothing, so there is nothing to gate; the answer lists what exists.
			return skill
				? readGate(skill.file, policy)
				: { decision: "allow", reason: "no skill by that name, so nothing is read", class: READ_CLASS };
		},
		execute: async (args: Record<string, unknown>, policy: Policy, execution: ExecutionPort): Promise<string> => {
			const available = options.skills();
			const requested = typeof args.name === "string" ? args.name : "";
			const skill = skillNamed(available, requested);
			if (!skill) {
				const names = available.map((entry) => entry.name).join(", ");
				return `error: you have no skill named "${requested}". Your skills: ${names || "none"}.`;
			}

			const read = await execution.readFile(skill.file, policy);
			if (!read.ok) return `error: ${read.error}`;
			const content = read.content ?? "";
			const version = skillFingerprint(content);
			const instructions = matter(content).content.trim();

			const guide = renderGuides(
				[{ name: skill.name, guide: instructions, source: `your skill, version sha256:${version}` }],
				{ perGuide: MAX_LOADED_SKILL_CHARS, total: MAX_LOADED_SKILL_CHARS },
			);

			const shownDir = (relative(policy.workspaceRoot, skill.dir) || skill.dir).replace(/\\/g, "/");
			const listing = await execution.listDir(skill.dir, policy);
			const supporting = listing.ok ? supportingFiles(listing.content ?? "") : [];

			return [
				guide ?? `The skill "${skill.name}" has no instructions in its SKILL.md.`,
				"",
				supporting.length > 0
					? `Files that come with it, in ${shownDir}: ${supporting.join(", ")}. Read one with read_file when the instructions point to it.`
					: "It comes with no other files.",
			].join("\n");
		},
	};
}
