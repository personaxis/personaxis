/**
 * What of a persona's own material a call used.
 *
 * ## Why this exists
 *
 * E80, 2026-09-14. A persona has skills, references, examples and assets, and its index (`work-map.ts`)
 * says what each one is for. Nothing wrote down that a turn actually leaned on one. In the autonomy
 * baseline of that day one of the two models never opened its reference, and only the bench's own trail
 * could show it: the record held the answer and nothing about where the answer came from.
 *
 * So a call that loaded a skill or read one of those files says so in the record, in the `call` entry that
 * already says what the gate decided about it (`record/entry.ts`).
 *
 * ## No new tool, on purpose
 *
 * `read_file` already crosses the gate, and reading a reference is reading. This looks at a call the loop
 * already made. A separate tool for "use a reference" would be one more entry in a catalogue a small model
 * has to choose from, for the same read.
 *
 * ## What counts
 *
 * - `use_skill` naming a skill the persona has: the skill, with the fingerprint of the `SKILL.md` it loads.
 * - `read_file` of a file that exists under the persona's own `references/`, `examples/` or `assets/`,
 *   resolved the way the tool resolves it (`absRead`): the workspace first, then the persona's resource
 *   roots. A path resolved any other way would name a file the persona never opened.
 *
 * A listing or a search over those folders is not a use: nothing in them was read. A skill's supporting
 * file is not counted either; loading the skill is the use, and it is already written.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";

import type { Policy } from "../sandbox.js";
import { readFileTool } from "../tools/builtin/read-file.js";
import { absRead } from "../tools/exec.js";
import { USE_SKILL_TOOL } from "../tools/use-skill.js";
import { localSkillsOf, skillFingerprint, skillNamed } from "./local-skills.js";
import type { TurnCall } from "./vocabulary.js";

type MaterialUse = NonNullable<TurnCall["used"]>;

/** The persona's folders whose files are material, and the word the record uses for each. */
const MATERIAL_FOLDERS: readonly (readonly [folder: string, kind: MaterialUse["kind"]])[] = [
	["references", "reference"],
	["examples", "example"],
	["assets", "asset"],
];

/** `target` lies below `dir`: not `dir` itself, and not a sibling that only starts with the same name. */
function below(dir: string, target: string): boolean {
	const rel = relative(dir, target);
	return rel.length > 0 && !isAbsolute(rel) && rel.split(/[\\/]/)[0] !== "..";
}

/** A path as the persona's index shows it: relative to the workspace when it is inside, with forward slashes. */
function shown(workspaceRoot: string, path: string): string {
	return (below(workspaceRoot, path) ? relative(workspaceRoot, path) : path).replace(/\\/g, "/");
}

/** The skill or file an allowed, successful call used, or nothing when it used none of the persona's material. */
export function materialUsed(call: {
	readonly tool: string;
	readonly args: Record<string, unknown>;
	readonly policy: Policy;
	readonly personaPath: string | undefined;
}): MaterialUse | undefined {
	if (call.personaPath === undefined) return undefined;

	if (call.tool === USE_SKILL_TOOL) {
		if (typeof call.args.name !== "string") return undefined;
		const skill = skillNamed(localSkillsOf(call.personaPath).skills, call.args.name);
		if (!skill) return undefined;
		try {
			return { kind: "skill", name: skill.name, version: skillFingerprint(readFileSync(skill.file, "utf8")) };
		} catch {
			// Loaded a moment ago and unreadable now: the use happened, the version cannot be named honestly.
			return { kind: "skill", name: skill.name };
		}
	}

	if (call.tool === readFileTool.name) {
		if (typeof call.args.path !== "string") return undefined;
		const opened = absRead(call.args.path, call.policy);
		// A missing file is answered with the names nearby, which is not a read of anything.
		if (!existsSync(opened)) return undefined;
		const folder = dirname(call.personaPath);
		for (const [name, kind] of MATERIAL_FOLDERS) {
			if (below(join(folder, name), opened)) return { kind, name: shown(call.policy.workspaceRoot, opened) };
		}
	}

	return undefined;
}
