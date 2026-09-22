/**
 * What a persona has, what each thing is for, and where work goes.
 *
 * ## Why this exists
 *
 * Asked for on 2026-09-14: a persona should know how everything it has is organised and where each
 * thing is done, so that it does not make things up. What it was given was a list of folders. The
 * runtime context named `references/` and `skills/` with the files inside them, and never said what
 * any of them was for, which services the persona delivers, or where a deliverable goes. A model that
 * does not know a skill exists will not use it, and one that sees only a file name has to open the
 * file to find out whether it matters.
 *
 * This is the index, at the level Agent Skills uses for skills, extended to everything else a persona
 * has: a name and the line that says what it is for. The full text stays on disk and is read when the
 * task needs it.
 *
 * ## Why it lives in core
 *
 * The folder listing was built by the CLI, so a turn run anywhere else, a hosted runner or an editor
 * over ACP, knew less about the persona than a turn in the TUI. Reading a persona's folder is the same
 * on a laptop and in the cloud, so it is the engine's.
 *
 * ## Byte-stable within a session
 *
 * It sits in the cached prefix, so nothing in it moves while a persona works. No posture: that is the
 * scope of the moment and travels in its own message (`agent.ts`, E20). No session list: the old
 * listing named every conversation file, so the prefix changed between the first turn of a session
 * and the second. No clock. Lists are sorted and capped, and what does not fit is counted, never
 * dropped without a word.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";

import matter from "gray-matter";

import { readMemoryTypes } from "../memory.js";
import { localSkillsOf } from "./local-skills.js";
import { RUN_SERVICE_TOOL } from "../tools/run-service.js";

/** One thing a persona has: its name, and the line that says what it is for. */
export interface MapItem {
	readonly name: string;
	readonly about: string;
}

/** A service the persona takes part in, and what a run of it has to leave behind. */
export interface MapService {
	readonly address: string;
	readonly name: string;
	readonly about: string;
	readonly delivers: readonly string[];
	readonly steps: number;
}

export interface WorkMap {
	/** Where the session works, and where deliverables go. */
	readonly workspace: string;
	/** The persona's own folder, relative to the workspace when it is inside it. */
	readonly ownFolder: string;
	readonly skills: readonly MapItem[];
	/** Declared local skills whose `SKILL.md` is not on disk. Said, because a silent gap looks like a skill the persona forgot. */
	readonly missingSkills: readonly string[];
	readonly services: readonly MapService[];
	readonly references: readonly MapItem[];
	readonly examples: readonly MapItem[];
	readonly assets: readonly MapItem[];
	/** The persona's own sub-personas, addressed from where it stands. */
	readonly subPersonas: readonly MapItem[];
	/** The memory kinds this persona keeps. */
	readonly memory: readonly string[];
}

/** How many items a section lists before it counts the rest. */
const PER_SECTION = 20;
/** How long the line about a file or a service may be. */
const ABOUT_CHARS = 140;
/**
 * E108: how much of what text files cover fits in ONE section of the map, and how long a section title may be.
 *
 * A budget for the whole section and not for each file, so twenty references cost the same as one and the
 * prompt cannot grow with the folder. Each listed file gets an equal share of it.
 *
 * The per-heading cap is separate: without it, one section with a paragraph for a title would eat the share
 * and the line would say what one section is about instead of what the file is about.
 */
const COVERS_SECTION_CHARS = 900;
const COVERS_ONE_CHARS = 60;
/** How long a skill's description may be. Agent Skills allows 1024; a small model reads less. */
const SKILL_CHARS = 300;
/** How deep a resource folder is listed. */
const RESOURCE_DEPTH = 2;
/** How deep sub-personas nest before the walk stops. */
const PERSONA_DEPTH = 5;

const TEXT_EXTENSIONS = new Set([".md", ".markdown", ".mdx", ".txt"]);

function oneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 3).trimEnd()}...`;
}

function frontmatterOf(file: string): Record<string, unknown> {
	try {
		return matter(readFileSync(file, "utf8")).data as Record<string, unknown>;
	} catch {
		return {};
	}
}

/**
 * E108: what a text file COVERS, from the headings under its title.
 *
 * Measured on 2026-09-22. Asked which sources its advice on game feel and juice rested on, a persona with
 * `references/web-research-2026-09-11.md` on disk answered that it had none, 0 of 6 across two models and six
 * measurements. That file holds a section called "game feel juice screen shake hit pause principles". The
 * question carried the words, the file carried the words, and the index line carried "What was read on the web,
 * and where it came from", because a title says where a file comes from and not what is in it. The engine had
 * the match and dropped it, which is the same shape as `check_page` holding the line number and returning only
 * the message.
 *
 * All of the sections or none of them, within the budget its section of the map allows. Deterministic, because
 * the map sits in the cached prefix and two renders of one file have to be the same bytes.
 */
function coveredIn(body: string, budget: number): string {
	const headings = [...body.matchAll(/^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm)].map((m) => m[1]!.trim()).filter((h) => h.length > 0);
	// The first heading is the title, which `aboutFile` already reports. Dropped by its TEXT and not by its
	// position: a file that repeats its title as a section printed it twice on one line, and a test caught it.
	const title = headings[0];
	const inside = [...new Set(headings.slice(1))].filter((heading) => heading !== title);
	if (inside.length === 0) return "";
	const listed = inside.map((heading) => oneLine(heading, COVERS_ONE_CHARS));
	const covers = ` Covers: ${listed.join("; ")}.`;
	// ALL of them or none, never the first few. Measured on 2026-09-22 and it cost a measurement: with the
	// list cut at four and "and 4 more" after it, a persona asked about game feel took the FIRST topic on the
	// list, searched the file for that, and cited the sources of the wrong section. The one it needed was
	// inside the "4 more". A partial list of what a file covers is read as the whole list, so it is worse than
	// no list: it turns an index into a menu of wrong answers.
	return covers.length <= budget ? covers : "";
}

/** What a file is about: its first heading, or its first line, or what kind of file it is, plus what it covers. */
function aboutFile(file: string, coversBudget = 0): string {
	const ext = extname(file).toLowerCase();
	if (!TEXT_EXTENSIONS.has(ext)) return `${ext.slice(1) || "binary"} file`;
	try {
		const body = matter(readFileSync(file, "utf8")).content;
		const heading = /^#{1,6}\s+(.+)$/m.exec(body)?.[1];
		const first = body
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find((line) => line.length > 0);
		return oneLine(heading ?? first ?? "(empty)", ABOUT_CHARS) + coveredIn(body, coversBudget);
	} catch {
		return "(unreadable)";
	}
}

/** Files under a folder, sorted, hidden entries skipped, to a fixed depth. */
function filesUnder(dir: string): string[] {
	const out: string[] = [];
	const walk = (current: string, level: number): void => {
		let entries: string[];
		try {
			entries = readdirSync(current).sort();
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.startsWith(".")) continue;
			const full = join(current, entry);
			let isDirectory: boolean;
			try {
				isDirectory = statSync(full).isDirectory();
			} catch {
				continue;
			}
			if (isDirectory) {
				if (level < RESOURCE_DEPTH) walk(full, level + 1);
			} else {
				out.push(full);
			}
		}
	};
	if (existsSync(dir)) walk(dir, 1);
	return out;
}

/**
 * The persona's address from its path: none for a main persona, `cmo` or `cmo/legal` for a
 * sub-persona. Read from the path because the address IS the path, under `.personaxis/personas/`.
 */
function addressOf(personaPath: string): string | undefined {
	const parts = personaPath.replace(/\\/g, "/").split("/");
	const root = parts.lastIndexOf(".personaxis");
	if (root < 0) return undefined;
	const between = parts.slice(root + 1, -1);
	const segments: string[] = [];
	for (let i = 0; i + 1 < between.length; i += 2) {
		if (between[i] !== "personas") break;
		segments.push(between[i + 1]!);
	}
	return segments.length > 0 ? segments.join("/") : undefined;
}

/** Declared local skills, with the description their own `SKILL.md` gives. One reader: `local-skills.ts`. */
function skillsOf(personaPath: string, frontmatter: Record<string, unknown>): { skills: MapItem[]; missing: string[] } {
	const { skills, missing } = localSkillsOf(personaPath, frontmatter);
	return {
		skills: skills.map((skill) => ({ name: skill.name, about: oneLine(skill.description || aboutFile(skill.file), SKILL_CHARS) })),
		missing,
	};
}

/**
 * Services in the workspace this persona takes part in. A main persona is the project's own and sees
 * all of them; a sub-persona sees the ones it leads or does a step of.
 */
function servicesFor(workspace: string, address: string | undefined): MapService[] {
	const dir = join(workspace, ".personaxis", "services");
	let files: string[];
	try {
		files = readdirSync(dir).filter((file) => file.endsWith(".json")).sort();
	} catch {
		return [];
	}
	const out: MapService[] = [];
	for (const file of files) {
		let definition: { name?: unknown; description?: unknown; leadPersonaRef?: unknown; steps?: unknown };
		try {
			definition = JSON.parse(readFileSync(join(dir, file), "utf8")) as typeof definition;
		} catch {
			continue;
		}
		const steps = Array.isArray(definition.steps) ? (definition.steps as Array<{ personaRef?: unknown; produces?: unknown }>) : [];
		const takesPart = address === undefined || definition.leadPersonaRef === address || steps.some((step) => step.personaRef === address);
		if (!takesPart) continue;
		const serviceAddress = basename(file, ".json");
		const delivers = [
			...new Set(steps.flatMap((step) => (Array.isArray(step.produces) ? step.produces.filter((p): p is string => typeof p === "string") : []))),
		];
		out.push({
			address: serviceAddress,
			name: typeof definition.name === "string" ? definition.name : serviceAddress,
			about: typeof definition.description === "string" ? oneLine(definition.description, ABOUT_CHARS) : "",
			delivers,
			steps: steps.length,
		});
	}
	return out;
}

/**
 * The persona's own sub-personas, depth first, each with the purpose its spec declares.
 *
 * Exported since E87, because handing work to a colleague has to reach exactly the ones the map SHOWS. A
 * second walk over the same folders would be an index and a mechanism that drift apart, which is the shape of
 * bug this repository keeps finding.
 */
export function subPersonasOf(folder: string): MapItem[] {
	const out: MapItem[] = [];
	const walk = (dir: string, chain: readonly string[]): void => {
		if (chain.length >= PERSONA_DEPTH) return;
		const personas = join(dir, "personas");
		let names: string[];
		try {
			names = readdirSync(personas).sort();
		} catch {
			return;
		}
		for (const name of names) {
			const spec = join(personas, name, "personaxis.md");
			if (!existsSync(spec)) continue;
			const address = [...chain, name];
			const identity = frontmatterOf(spec).identity as { system_identity?: { purpose?: unknown } } | undefined;
			const purpose = identity?.system_identity?.purpose;
			out.push({ name: address.join("/"), about: typeof purpose === "string" ? oneLine(purpose, ABOUT_CHARS) : "" });
			walk(join(personas, name), address);
		}
	};
	walk(folder, []);
	return out;
}

function shown(workspace: string, path: string): string {
	const rel = relative(workspace, path);
	return (rel && !rel.startsWith("..") ? rel : path).replace(/\\/g, "/");
}

/** Everything a persona has, read from its folder and its workspace. */
export function workMapFor(personaPath: string, options: { readonly workspaceRoot: string; readonly frontmatter?: Record<string, unknown> }): WorkMap {
	const folder = dirname(personaPath);
	const frontmatter = options.frontmatter ?? frontmatterOf(personaPath);
	const { skills, missing } = skillsOf(personaPath, frontmatter);
	const listed = (sub: string): MapItem[] =>
		((files) =>
			// E108: the covers budget is for the whole section, split evenly, so twenty references cost the same
			// as one and this cannot grow with the folder.
			files.map((file) => ({
				name: shown(options.workspaceRoot, file),
				about: aboutFile(file, Math.floor(COVERS_SECTION_CHARS / Math.max(1, Math.min(files.length, PER_SECTION)))),
			})))(filesUnder(join(folder, sub)));
	const kinds = readMemoryTypes(frontmatter) as unknown as Record<string, unknown>;
	return {
		workspace: options.workspaceRoot.replace(/\\/g, "/"),
		ownFolder: shown(options.workspaceRoot, folder),
		skills,
		missingSkills: missing,
		services: servicesFor(options.workspaceRoot, addressOf(personaPath)),
		references: listed("references"),
		examples: listed("examples"),
		assets: listed("assets"),
		subPersonas: subPersonasOf(folder),
		memory: Object.entries(kinds)
			.filter(([, on]) => on === true)
			.map(([kind]) => kind.replace(/_/g, " "))
			.sort(),
	};
}

/**
 * The map as the model reads it.
 *
 * Deterministic: the same map renders the same bytes, which is what lets it sit in the cached prefix.
 */
export function renderWorkMap(
	map: WorkMap,
	limits: {
		readonly perSection?: number;
		/**
		 * E73: whether this turn can run a service, because its host lent one. Only then does the index name
		 * `run_service`: a service step reads the same index and has no such tool, and a model told of a tool
		 * it does not have calls it anyway.
		 */
		readonly canRunServices?: boolean;
	} = {},
): string {
	const cap = limits.perSection ?? PER_SECTION;
	const lines: string[] = [
		"## What you have, and when to use it",
		"",
		"This is an index. Each line says what a thing is for; open a file only when the task needs it.",
	];
	const section = (title: string, intro: string, items: readonly string[], where: string): void => {
		if (items.length === 0) return;
		lines.push("", `### ${title}`, intro, ...items.slice(0, cap));
		if (items.length > cap) lines.push(`- ...and ${items.length - cap} more in ${where}; list it when you need one.`);
	};

	section(
		"Skills",
		"Your methods. When a task fits one, load it with use_skill before doing the work, then follow it.",
		map.skills.map((skill) => `- ${skill.name}: ${skill.about} (${map.ownFolder}/skills/${skill.name}/SKILL.md)`),
		`${map.ownFolder}/skills/`,
	);
	if (map.missingSkills.length > 0) {
		lines.push(`Declared but not on disk, so not available: ${map.missingSkills.join(", ")}.`);
	}
	// E73: presented as what the persona offers a client, not as mechanics. Measured on 2026-09-14 (E79): listed
	// as "a fixed sequence of steps", no persona named its service when asked what it could do, 0 of 3 with both
	// models. Whether this wording moves that is measured in E73, not assumed.
	section(
		"Services you deliver",
		limits.canRunServices === true
			? `What you offer a client, done start to finish. When a request is what one of these delivers, say so and run it with ${RUN_SERVICE_TOOL}; the person approves every run first. Every step has to leave the files it names, or the run fails.`
			: "What you offer a client, done start to finish. Every step has to leave the files it names, or the run fails.",
		map.services.map((service) => {
			// The description's own full stop is dropped: the line goes on after it, and "agree.. 2 steps"
			// is what a model read before a test caught it.
			const about = service.about ? `: ${service.about.replace(/[.\s]+$/, "")}` : "";
			const leaves = service.delivers.length > 0 ? `leaves ${service.delivers.join(", ")}` : "declares no files";
			return `- ${service.address} ("${service.name}")${about}. ${service.steps} step${service.steps === 1 ? "" : "s"}, ${leaves}.`;
		}),
		".personaxis/services/",
	);
	const item = (entry: MapItem): string => `- ${entry.name}: ${entry.about}`;
	// E91: the same promise Memory makes below, and for the same reason. Asked which sources its advice rested
	// on, a persona with exactly that file on disk answered "I do not have a specific external source list",
	// 0 of 6 across two models. It was shown the file every turn and never opened it. Memory says to look
	// before denying; this said nothing, so "I have no sources" was the references version of "I do not
	// remember".
	//
	// E103: and then it names the tool, which is what E91 still left out. Of the five sections here that ask
	// for an action, the three that name their tool are the three that get used: `use_skill` 476 calls across
	// the 505 bench runs, `memory_search` 91, `run_service` 27. This one asked to read and named nothing, and
	// on the same screen in the same turn a model called `memory_search` and then said it had no sources
	// without opening the file listed right above. A promise with no tool in it is a sentence, not an action.
	section(
		"References",
		"Background material you draw on. Open the one that fits with read_file, by the path below, before saying you do not know where something of yours comes from.",
		map.references.map(item),
		`${map.ownFolder}/references/`,
	);
	section("Examples", "Worked outputs, to match their format and voice.", map.examples.map(item), `${map.ownFolder}/examples/`);
	section("Assets", "Supporting files.", map.assets.map(item), `${map.ownFolder}/assets/`);
	// E103: the title always said "hand work to" and the body only offered to read, so reading is what happened.
	// Asked for something only the colleague knows how to do, a persona with that colleague listed here opened the
	// colleague's folder and wrote the report itself, 3 of 3. `delegate` was in its catalogue the whole time: 3
	// calls to it in 505 bench runs against 476 to `use_skill`, which the Skills section does name. So the tool
	// comes first and the permission to read comes after it, as the qualifier it always was.
	section(
		"Sub-personas you can hand work to",
		"Specialists with their own definition, memory and limits. When a task is what one of them is made for, give it to them with delegate and their address below, rather than doing it yourself. You may read their files; you never write them.",
		map.subPersonas.map((sub) => `- @${sub.name}${sub.about ? `: ${sub.about}` : ""}`),
		`${map.ownFolder}/personas/`,
	);
	if (map.memory.length > 0) {
		lines.push("", "### Memory", `You keep: ${map.memory.join(", ")}. Search it with memory_search before saying you do not remember.`);
	}

	const nothing =
		map.skills.length + map.services.length + map.references.length + map.examples.length + map.assets.length + map.subPersonas.length === 0;
	if (nothing) lines.push("", "You have no skills, services, references, examples, assets or sub-personas yet.");

	lines.push(
		"",
		"## Where things go",
		`- Work happens in the workspace, \`${map.workspace}\`. What you deliver is written there.`,
		`- Your own folder is \`${map.ownFolder}\`: your definition, state, memory, skills and references. Read from it; do not rewrite your definition or your skills.`,
		"- Read heavy material by its path when the task needs it, not all at once.",
	);
	return lines.join("\n");
}
