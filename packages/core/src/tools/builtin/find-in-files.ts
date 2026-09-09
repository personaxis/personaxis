/**
 * `find_in_files` (C5): where a piece of text is, without reading everything.
 *
 * The catalogue had `list_dir` and `read_file` and nothing between them, so a persona
 * looking for where a function is defined had two options: walk the tree a directory at
 * a time, or read whole files until one matched. Both spend the context this tool
 * exists to save, and one of them is not available at all: **a `read-only` persona has
 * no shell**, so it could not fall back to `grep` the way a persona with commands can.
 *
 * ## Literal text, not a regular expression, and that is a security decision
 *
 * A pattern the model wrote is untrusted input. A regular expression from untrusted
 * input can be made to backtrack catastrophically, and one line of a checked-in file is
 * enough to hang the process for minutes: a search that can stop a run is worse than
 * one that cannot match `\d+`. What a search is actually for here is a symbol, a
 * string, a path, and those are literals.
 *
 * ## What it walks, and what it will not
 *
 * Down from the path the gate approved, never constructing a path outside it. A symlink
 * is followed by the filesystem exactly as `read_file` would follow it, which is the
 * boundary that already exists rather than a new one: containment is the gate's job and
 * the gate is upstream. Said out loud because `nearby.ts` walking UP had to enforce its
 * own, and the difference is worth a sentence rather than a guess.
 *
 * `node_modules` and `.git` are skipped, and the answer SAYS they were. Those two make
 * a search of any real project useless; every other directory is fair game, because a
 * skip list that quietly hides the answer is worse than a slow search.
 */

import { defineTool } from "../define.js";
import { readGate } from "../gates.js";
import type { ExecutionPort } from "../../ports/execution.js";
import type { Policy } from "../../sandbox.js";

/**
 * How many directories one search opens.
 *
 * A ceiling and not a promise of completeness: past it the answer says it stopped, so a
 * partial result is never mistaken for "it is not there". Two hundred covers a real
 * project once `node_modules` is out of the way, and bounds a walk somebody points at a
 * home directory by mistake.
 */
const MAX_DIRS = 200;

/** How many matching lines come back. Enough to see a pattern, not enough to be the files. */
const MAX_MATCHES = 60;

/** Per line, because a minified bundle is one line and would be the whole answer. */
const MAX_LINE_CHARS = 300;

/** Directories that make a search useless and are never the answer. */
const SKIPPED = new Set(["node_modules", ".git"]);

export const findInFilesTool = defineTool({
	name: "find_in_files",
	category: "fs",
	isReadOnly: true,
	isConcurrencySafe: true,
	description:
		"Find which files contain a piece of text, and on which lines. The text is matched " +
		"literally, not as a regular expression. Searches down from `path` (default: the " +
		"workspace root), skipping node_modules and .git.",
	parameters: {
		type: "object",
		additionalProperties: false,
		required: ["text"],
		properties: {
			text: { type: "string", description: "The exact text to look for." },
			path: { type: "string", description: "Where to search from. Defaults to the workspace root." },
		},
	},
	// The same gate a read is, on the directory it starts from. Every file it opens
	// afterwards goes through the port, which resolves against the workspace root.
	gate: (args, policy) => readGate(args.path ?? ".", policy),
	execute: async (args, policy, execution) => {
		const needle = args.text;
		if (needle.length === 0) return "error: find_in_files needs some text to look for.";

		const found = await search(needle, args.path ?? ".", policy, execution);
		return describe(found, needle);
	},
});

interface Hit {
	readonly path: string;
	readonly line: number;
	readonly text: string;
}

interface Found {
	readonly hits: readonly Hit[];
	/** True when a ceiling stopped the walk, so silence does not read as absence. */
	readonly stopped: boolean;
	readonly skipped: number;
}

async function search(
	needle: string,
	from: string,
	policy: Policy,
	execution: ExecutionPort,
): Promise<Found> {
	const hits: Hit[] = [];
	const queue: string[] = [from];
	let opened = 0;
	let skipped = 0;
	let stopped = false;

	while (queue.length > 0) {
		if (opened >= MAX_DIRS || hits.length >= MAX_MATCHES) {
			stopped = true;
			break;
		}

		const dir = queue.shift() as string;
		const listing = await execution.listDir(dir, policy);
		opened += 1;
		if (!listing.ok || !listing.content) continue;

		for (const entry of listing.content.split("\n")) {
			const name = entry.trim();
			if (!name) continue;

			if (name.endsWith("/")) {
				const child = name.slice(0, -1);
				if (SKIPPED.has(child)) {
					skipped += 1;
					continue;
				}
				queue.push(join(dir, child));
				continue;
			}

			if (hits.length >= MAX_MATCHES) {
				stopped = true;
				break;
			}

			const file = join(dir, name);
			const read = await execution.readFile(file, policy);
			// A binary answers with a sentence ABOUT itself rather than its bytes, so
			// searching its `content` would match the sentence and report a hit inside an
			// image. Skipped by the flag the reader sets, never by matching its words.
			if (!read.ok || read.binary || read.content === undefined) continue;

			hits.push(...matchesIn(file, read.content, needle, MAX_MATCHES - hits.length));
		}
	}

	return { hits, stopped: stopped || hits.length >= MAX_MATCHES, skipped };
}

function matchesIn(path: string, content: string, needle: string, room: number): Hit[] {
	const hits: Hit[] = [];
	const lines = content.split("\n");

	for (let index = 0; index < lines.length && hits.length < room; index += 1) {
		const line = lines[index] as string;
		if (!line.includes(needle)) continue;
		hits.push({
			path,
			line: index + 1,
			text: line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line,
		});
	}

	return hits;
}

/**
 * The answer, and what it does not cover.
 *
 * Nothing found is a real result and says so plainly. What it must never do is say
 * nothing found when a ceiling stopped it early: that is the difference between "it is
 * not here" and "I stopped looking", and a model acts very differently on the two.
 */
function describe(found: Found, needle: string): string {
	const notes: string[] = [];
	if (found.stopped) notes.push("this search hit its ceiling and stopped early, so there may be more");
	if (found.skipped > 0) {
		notes.push(`${found.skipped} directory(ies) skipped: node_modules and .git are not searched`);
	}
	const tail = notes.length > 0 ? `\n\n[${notes.join("; ")}]` : "";

	if (found.hits.length === 0) return `no file contains ${JSON.stringify(needle)}.${tail}`;

	const lines = found.hits.map((hit) => `${hit.path}:${hit.line}: ${hit.text.trim()}`);
	return `${found.hits.length} match(es):\n${lines.join("\n")}${tail}`;
}

/** Joined the way these tools speak paths: forward slashes, no leading "./". */
function join(dir: string, name: string): string {
	const base = dir === "." || dir === "" ? "" : dir.replace(/[\\/]+$/, "");
	return base ? `${base}/${name}` : name;
}
