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

import { createHash } from "node:crypto";
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
	/**
	 * E135: the files the skill says it delivers, from `metadata.personaxis.delivers` in its own frontmatter.
	 * Empty when it declares none, which is most skills: advice, a checklist, a way of looking at something.
	 *
	 * Declared and never inferred. The first version read `allowed-tools`, and a skill that MAY write (so it can
	 * edit a game when asked to) was taken for one that must deliver a file, which turned a request for advice
	 * into a hand-back and cost the answer its numbers (plan, E135). Under `metadata`, the free block the skill
	 * format already has, so a skill that declares it is still a valid `SKILL.md` for any other agent.
	 */
	readonly delivers: readonly string[];
}

/** `metadata.personaxis.delivers` as a list of file names, whatever shape it came in. */
function declaredDeliveries(data: Record<string, unknown>): string[] {
	const metadata = data.metadata;
	const ours = metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>).personaxis : undefined;
	const raw = ours && typeof ours === "object" ? (ours as Record<string, unknown>).delivers : undefined;
	const items = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
	return items.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
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
		const data = frontmatterOf(file);
		const description = data.description;
		skills.set(name, {
			name,
			description: typeof description === "string" ? description.replace(/\s+/g, " ").trim() : "",
			dir,
			file,
			delivers: declaredDeliveries(data),
		});
	}
	return {
		skills: [...skills.values()].sort((a, b) => a.name.localeCompare(b.name)),
		missing: [...missing].sort(),
	};
}

/**
 * The skill a name asks for, matched the way a person or a model writes it: whatever the case, with stray
 * spaces trimmed. One matcher for `use_skill`, which loads the skill, and for the record, which writes down
 * that it was loaded (E80), so the two cannot disagree about which skill a name meant.
 */
export function skillNamed(skills: readonly LocalSkill[], requested: string): LocalSkill | undefined {
	const wanted = requested.trim().toLowerCase();
	return skills.find((skill) => skill.name.toLowerCase() === wanted);
}

/**
 * The version a loaded skill is named by: the first 16 hex characters of the SHA-256 of its `SKILL.md` as
 * read. One place, so the version `use_skill` shows the persona and the one the record keeps are the same.
 */
export function skillFingerprint(content: string): string {
	return createHash("sha256").update(content).digest("hex").slice(0, 16);
}
