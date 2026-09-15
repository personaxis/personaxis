/**
 * A persona's own skills, as they are on disk.
 *
 * One reader, for the two places that need it: the work map, which says what each skill is for, and
 * `use_skill`, which loads one. Two readers would sooner or later disagree about which skills a persona
 * has, and a persona told it has a skill it cannot load, or able to load one its index never showed,
 * is the kind of gap nobody notices from inside either file.
 *
 * Only LOCAL skills are read. A `github:` or registry reference points at something that is not on this
 * disk, and a run never fetches it: pulling a skill is `personaxis skills pull`, with its review.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import matter from "gray-matter";

export interface LocalSkill {
	/** The skill's name, which is also its folder under `skills/`. */
	readonly name: string;
	/** What its own `SKILL.md` says it is for, on one line. Empty when it says nothing. */
	readonly description: string;
	/** The skill's folder. */
	readonly dir: string;
	/** Its `SKILL.md`. */
	readonly file: string;
}

function frontmatterOf(file: string): Record<string, unknown> {
	try {
		return matter(readFileSync(file, "utf8")).data as Record<string, unknown>;
	} catch {
		return {};
	}
}

/**
 * The local skills a persona declares, sorted by name, and the declared ones whose `SKILL.md` is not
 * on disk, named rather than dropped.
 */
export function localSkillsOf(personaPath: string, frontmatter?: Record<string, unknown>): { skills: LocalSkill[]; missing: string[] } {
	const folder = dirname(personaPath);
	const spec = frontmatter ?? frontmatterOf(personaPath);
	const declared = (spec.extensions as { skills?: unknown } | undefined)?.skills;
	const entries = Array.isArray(declared) ? declared.filter((entry): entry is string => typeof entry === "string") : [];

	const skills = new Map<string, LocalSkill>();
	const missing = new Set<string>();
	for (const entry of entries) {
		if (entry.startsWith("@") || entry.startsWith("github:")) continue;
		const name = entry.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() ?? entry;
		const dir = join(folder, "skills", name);
		const file = join(dir, "SKILL.md");
		if (!existsSync(file)) {
			missing.add(name);
			continue;
		}
		const description = frontmatterOf(file).description;
		skills.set(name, {
			name,
			description: typeof description === "string" ? description.replace(/\s+/g, " ").trim() : "",
			dir,
			file,
		});
	}
	return {
		skills: [...skills.values()].sort((a, b) => a.name.localeCompare(b.name)),
		missing: [...missing].sort(),
	};
}
