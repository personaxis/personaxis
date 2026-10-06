import { readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/**
 * What a step left behind in the project directory.
 *
 * A service step's real output is usually a file: notes written, a migration
 * drafted, a report generated. The workspace could not name one of them. The
 * delivery said "it is in your folder", which is true and is the whole of what
 * it could say, so a person reading a finished delivery had no idea whether it
 * had produced three files or none.
 *
 * ## The bytes do not travel, and that is the design
 *
 * This reports names and sizes. It never reads a file's contents and never
 * sends one. The connected mode is sold on nothing leaving the operator's
 * machine, and a delivery that quietly uploaded a client's work would make that
 * sentence false, so the thing that crosses the wire is the fact that a file
 * exists and how big it is.
 *
 * Paths are relative to the project directory for the same reason. An absolute
 * path carries the operator's home directory and their username, which the
 * workspace did not ask for.
 *
 * ## Bounded, because a project directory is somebody else's repository
 *
 * A scan with no ceiling is the unbounded work this codebase refuses elsewhere,
 * and here it would run on a stranger's disk. Three limits, and each reports
 * rather than silently truncating: how deep it walks, how many files it will
 * name, and which directories it does not enter at all.
 *
 * The skipped list is not an optimisation. `node_modules` and `.git` change on
 * every install and every commit, so a step that ran `pnpm install` would
 * otherwise report forty thousand files it did not write.
 */

/** Directories a step's output is never in, and whose churn would drown it. */
const SKIP = new Set([
	".git",
	"node_modules",
	".next",
	"dist",
	"build",
	"target",
	".turbo",
	".venv",
	"__pycache__",
	".cache",
	"vendor",
]);

/** How far down. Deeper than this is a tree, not an output. */
const MAX_DEPTH = 6;

/**
 * How many files are named.
 *
 * Past this the answer becomes "at least this many", which is a smaller lie
 * than a delivery that takes a minute to assemble because a step touched a
 * build directory this list does not know about yet.
 */
const MAX_FILES = 200;

/** A file bigger than this is named and its size reported; nothing else changes. */
export interface ProducedFile {
	/** Relative to the project directory, with forward slashes on every platform. */
	path: string;
	bytes: number;
	/** Milliseconds since the epoch, for deciding what the step touched. */
	modifiedAt: number;
}

export interface ProducedScan {
	files: ProducedFile[];
	/** True when the walk stopped at a limit, so callers can say so. */
	capped: boolean;
}

/**
 * Every file under `root`, bounded.
 *
 * Errors on a single entry are skipped rather than thrown. A directory the
 * daemon cannot read is a real thing on somebody's machine, and failing the
 * whole scan because of one would lose the report for every file that was
 * readable.
 */
export async function scanDirectory(root: string): Promise<ProducedScan> {
	const files: ProducedFile[] = [];
	let capped = false;

	async function walk(dir: string, depth: number): Promise<void> {
		if (depth > MAX_DEPTH || files.length >= MAX_FILES) {
			capped = capped || files.length >= MAX_FILES;
			return;
		}

		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries) {
			if (files.length >= MAX_FILES) {
				capped = true;
				return;
			}

			const full = join(dir, entry.name);

			if (entry.isDirectory()) {
				if (SKIP.has(entry.name)) continue;
				await walk(full, depth + 1);
				continue;
			}

			// Symlinks are not followed. A link pointing outside the project is a
			// path the operator never consented to, and reporting its size would
			// answer a question about a file this step has no business naming.
			if (!entry.isFile()) continue;

			try {
				const info = await stat(full);
				files.push({
					path: relative(root, full).split(sep).join("/"),
					bytes: info.size,
					modifiedAt: info.mtimeMs,
				});
			} catch {
				// Gone between the listing and the stat: a temporary file the step
				// wrote and removed. Nothing to report.
			}
		}
	}

	await walk(root, 0);
	return { files, capped };
}

/**
 * What changed between two scans.
 *
 * Compared by path and modification time rather than by content, because
 * reading a file to hash it is reading a file, and this deliberately does not.
 * The cost is that a file rewritten with identical bytes counts as produced;
 * that is the right way to be wrong here, because the alternative misses a file
 * whose timestamp moved for a reason the daemon cannot see.
 *
 * A file that shrank to nothing, or that was deleted, is not reported: this
 * answers "what did the step leave", and a deletion leaves nothing to open.
 */
export function producedBetween(before: ProducedScan, after: ProducedScan): ProducedFile[] {
	const previous = new Map(before.files.map((file) => [file.path, file]));

	return after.files.filter((file) => {
		const was = previous.get(file.path);
		return !was || was.modifiedAt !== file.modifiedAt || was.bytes !== file.bytes;
	});
}

/**
 * What kind of thing this is, from its name.
 *
 * The vocabulary is the one the `artifact` table already documents, so a row
 * written from this event and a row written by a hosted run describe themselves
 * the same way. Anything unrecognised is `file` rather than a guess: `json` on
 * something that turned out to be a log is worse than no claim at all.
 */
export function kindOf(path: string): string {
	const dot = path.lastIndexOf(".");
	const extension = dot === -1 ? "" : path.slice(dot + 1).toLowerCase();

	if (extension === "md" || extension === "markdown") return "markdown";
	if (extension === "pdf") return "pdf";
	if (extension === "csv" || extension === "tsv") return "table";
	if (extension === "diff" || extension === "patch") return "diff";
	if (["png", "jpg", "jpeg", "gif", "svg", "webp"].includes(extension)) return "image";
	if (extension === "json") return "json";
	if (extension === "html" || extension === "htm") return "web";
	return "file";
}

/**
 * What the event says about a file, in words, without quoting it.
 *
 * Describes rather than samples. The first kilobyte of a file is the file, and
 * the contents are exactly what does not travel.
 */
export function describeFile(file: ProducedFile): string {
	const size =
		file.bytes < 1024
			? `${file.bytes} bytes`
			: file.bytes < 1024 * 1024
				? `${(file.bytes / 1024).toFixed(1)} KB`
				: `${(file.bytes / (1024 * 1024)).toFixed(1)} MB`;

	return `${kindOf(file.path)}, ${size}, left in the project folder`;
}
