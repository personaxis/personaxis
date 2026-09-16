/**
 * What a turn left behind: the files its calls wrote, with the moment each one was written.
 *
 * ## Why this exists
 *
 * E85, 2026-09-15. A turn that produced deliverables had no list of them. `TurnCall` carries no path, the
 * record keeps only what the persona READ of its own material (`used`, E80), and `taskState.noteFile` mixes
 * reads with writes and is pruned to a ceiling, so neither could say "this turn left these files". Without
 * that list there is nothing to derive a check from, and nothing to go stale when the file changes later.
 *
 * Sibling of `material-use.ts` on purpose, and read at the same place in the loop: that is the one point that
 * sees the call, its arguments and whether it succeeded. A second way of resolving a path would be a second
 * answer to "which file was that", and the gate's answer is the only one that counts.
 *
 * ## What counts as delivered
 *
 * A call that was allowed, ran and succeeded, and whose tool writes: `write_file` and `edit_file`. Not a read,
 * not a listing, not a search, and not a command: a shell command can write anything anywhere, and claiming to
 * know what it left would be guessing. A command's evidence is its exit code, judged by `exitCodeAttributes`.
 */

import { editFileTool } from "../tools/builtin/edit-file.js";
import { writeFileTool } from "../tools/builtin/write-file.js";
import { absRead } from "../tools/exec.js";
import type { Policy } from "../sandbox.js";

/** A file a turn left, as the workspace names it, and when the call that wrote it ended. */
export interface Delivered {
	/** Resolved the way the tools resolve it, so it names the file that was actually written. */
	readonly path: string;
	/** Milliseconds, this process's clock. Evidence about this file is stale once the file moves past it. */
	readonly at: number;
}

const WRITERS: readonly string[] = [writeFileTool.name, editFileTool.name];

/**
 * The file an allowed, successful call left, or nothing when the call left none.
 *
 * `at` is taken by the caller rather than here, so a test can hand a clock and a real run hands `Date.now()`
 * at the moment the call returned, which is the moment the evidence is about.
 */
export function deliveredBy(call: {
	readonly tool: string;
	readonly args: Record<string, unknown>;
	readonly policy: Policy;
	readonly at: number;
}): Delivered | undefined {
	if (!WRITERS.includes(call.tool) || typeof call.args.path !== "string") return undefined;
	return { path: absRead(call.args.path, call.policy), at: call.at };
}

/**
 * The turn's deliverables, one entry per file, keeping the LAST write of each.
 *
 * The last one, because that is the version the evidence would be about: a file written and then edited again
 * has moved past any check taken in between, which is what `staleAgainst` reads.
 */
export function deliveredIn(entries: readonly Delivered[]): Delivered[] {
	const byPath = new Map<string, Delivered>();
	for (const entry of entries) {
		const seen = byPath.get(entry.path);
		if (seen === undefined || entry.at >= seen.at) byPath.set(entry.path, entry);
	}
	return [...byPath.values()];
}

/**
 * ## Staleness is not here yet, on purpose
 *
 * The note's rule is that evidence plus a later edit is obsolete, and that obsolete is CALCULATED rather than
 * stored. Inside one turn there is nothing to calculate: the checks run after the last write, over the version
 * that survived, which is what `deliveredIn` keeps. Across turns there is, and it belongs to whoever reads the
 * evidence back out of the record, which nothing does today. A function written here for that reader would be
 * an export nothing reaches, which is exactly what `E98` had just finished paying for.
 */
