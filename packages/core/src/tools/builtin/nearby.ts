/**
 * What IS there, for a path that is not.
 *
 * E31, and the measurement behind it is worth stating because it rules out the obvious
 * fix. Against a real model, over twenty runs, the missing-file branch fired eight times
 * and the persona abandoned the task in seven of those eight: one `list_dir`, one call,
 * and "I'm sorry, I can't find the config file" with the file sitting in `src/`. It was
 * the dominant cause of failure in both banks of `E28`, above everything else.
 *
 * The obvious fix was tried and discarded. Replacing `Continue with what you have.` with
 * a sentence that offers a next step instead of closing one recovered 1 of 4 against 0
 * of 4, which at that n is noise. So a better sentence is not the answer, and the
 * measurement points somewhere firmer: **if the model will not take the next step, take
 * it for it**. The next step after a path that does not exist is looking at what is
 * around it, that is deterministic, and the runtime can do it without asking the model
 * for anything.
 *
 * ## The walk bounds itself, and this is the part that was nearly wrong
 *
 * The gate approved the path the CALLER asked for. This looks at its parent, which the
 * gate never saw, so the containment has to be here. It was written first assuming the
 * port would enforce it, and a negative control said otherwise inside a minute: with a
 * workspace that was empty, the walk climbed out and listed twenty thousand entries of
 * the machine's temp directory. `readFileSafe` and `listDirSafe` resolve with
 * `resolve(workspaceRoot, path)` and check nothing, because containment is the GATE's
 * job and the gate is upstream of here.
 *
 * So the walk stops at `workspaceRoot`, by comparing resolved paths, and never lists a
 * directory that is not inside it. This can only ever spend a read the persona was
 * already entitled to.
 */

import { relative, resolve } from "node:path";

import type { Policy } from "../../sandbox.js";
import type { ExecutionPort } from "../../ports/execution.js";

/**
 * How far up to walk.
 *
 * Three, because the useful case is a name that is wrong or a directory that moved, and
 * both are within a step or two. Walking to the root would answer a question nobody
 * asked with a listing nobody can use.
 */
const LEVELS = 3;

/**
 * How many names to show.
 *
 * A cap rather than everything, because `node_modules` exists. The count of what is left
 * out is included: a truncated list that does not say it is truncated invites the model
 * to conclude a file is absent from a listing that simply stopped.
 */
const NAMES = 40;

/** The parent of a path, in the separator-agnostic way these tools speak. */
function parentOf(path: string): string | undefined {
	const trimmed = path.replace(/[\\/]+$/, "");
	const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
	if (cut <= 0) return undefined;
	return trimmed.slice(0, cut);
}

/**
 * Whether a path is the workspace root or sits under it.
 *
 * Via `relative`, which answers with a leading `..` for anything above and an absolute
 * path for a different drive. Both are the same answer here: outside.
 */
function within(candidate: string, root: string): boolean {
	const step = relative(resolve(root), resolve(candidate));
	return step === "" || (!step.startsWith("..") && !/^[a-zA-Z]:/.test(step));
}

function shorten(content: string): string {
	const names = content.split("\n").filter((name) => name.length > 0);
	if (names.length <= NAMES) return names.join("\n");
	return [...names.slice(0, NAMES), `... and ${names.length - NAMES} more`].join("\n");
}

/**
 * The nearest directory above a missing path that can be listed, and its contents.
 *
 * Empty string when there is nothing to say: no readable ancestor inside the workspace,
 * or one that is empty. Empty rather than a sentence explaining the emptiness, because
 * the whole point is to hand over names, and prose about the absence of names is what
 * this replaces.
 */
export async function whatIsNearby(
	path: string,
	policy: Policy,
	execution: ExecutionPort,
): Promise<string> {
	const root = policy.workspaceRoot;
	let here = parentOf(path);

	for (let level = 0; level < LEVELS && here !== undefined; level += 1) {
		if (!within(here, root)) return "";

		const listed = await execution.listDir(here, policy);
		if (listed.ok && (listed.content ?? "").trim().length > 0) {
			return `${listed.path} contains:\n${shorten(listed.content ?? "")}`;
		}
		here = parentOf(here);
	}

	return "";
}

/**
 * What a tool says about a path that is not there.
 *
 * `note:` and not `error:`, which is `V3.1` and is load-bearing: marking a missing file
 * as an error zeroed step progress and tripped the no-progress and execution-error stop
 * conditions, so one optional read could abort a whole run without a reply.
 *
 * What is gone is `Continue with what you have.` It is not replaced by a better sentence,
 * because that was measured and did nothing. It is replaced by the listing, and leaving
 * the sentence in front of one would be telling the persona to stop looking on the same
 * line as handing it the place to look. When there is no listing to give, the note stands
 * alone: a bare fact is still not an instruction to give up.
 */
export function missingPathNote(path: string, nearby: string): string {
	return nearby.length > 0
		? `note: ${path} does not exist.\n${nearby}`
		: `note: ${path} does not exist.`;
}
