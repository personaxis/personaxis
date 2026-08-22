#!/usr/bin/env node
// The planning folder, checked the way everything else here is checked.
//
//   pnpm plan:check
//
// `plan/` is gitignored, so this runs locally and not in CI. That is the point
// rather than a limitation: the failure it guards against is a person, or a
// model, resuming work on a stale document after a break, and CI never resumes
// anything.
//
// Every rule below exists because the thing it forbids already happened once:
//
//   Four documents carried no status at all, so nobody could tell whether they
//   were live. One was a proposal explicitly marked "nothing here is built".
//
//   `NEXT_STEPS.md` had a header dated 2026-07-31 and content edited on
//   2026-08-08, and read as current three weeks after it stopped being true.
//
//   Five plan systems were live at once across two repositories and a folder
//   outside both, and the one that said "start here" was the oldest of them.
//
//   A checklist marked items done with no way to find what closed them, so
//   "done" meant "somebody typed an x".

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const PLAN = join(ROOT, "plan");

const problems = [];
const seen = new Set();

/** A dated filename: `NAME_YYYY-MM-DD.md`. */
const DATED = /_(\d{4}-\d{2}-\d{2})\.md$/;

/**
 * Which states mean "this captured a moment and then stopped".
 *
 * Those carry the date in the filename, so a stale document is visible in a
 * directory listing without opening it. A document still being worked on does
 * not, because renaming a file on every edit breaks every link that names it.
 *
 * A live document MAY still be dated when the date is part of its identity, as
 * the master plan's is. Dating is required of the settled ones and allowed of
 * the rest.
 */
const SETTLED = new Set(["superseded", "done", "paused"]);

/**
 * The one document that is nobody's child.
 *
 * Everything else at the top level declares its parent with `plan:`, which is
 * what makes "how many plans are live here" answerable at all. The index is the
 * map of the plans and therefore subordinate to none of them.
 */
const ROOT_DOCUMENT = "INDEX.md";

const VALID_STATUS = new Set(["active", "paused", "superseded", "done", "todo"]);

/**
 * The sealed archive: `history/` below its own top level.
 *
 * A superseded plan from an earlier era is a box, not a shelf. Demanding a
 * header on each of its twenty-two files would be ceremony over documents nobody
 * resumes from, and ceremony that costs something is ceremony people delete. The
 * box itself is labelled: `history/README.md` says what is in it and that none of
 * it is to be followed, and the index says the same.
 *
 * What this does NOT exempt is the top level of `history/`, where the recently
 * archived documents live. Those are the ones somebody might still mistake for
 * current, so those carry their status and their `superseded_by`.
 */
const SEALED = join(PLAN, "history");

function markdownFiles(dir, depth = 0) {
	const found = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (dir === SEALED) continue;
			found.push(...markdownFiles(path, depth + 1));
		} else if (entry.name.endsWith(".md")) found.push(path);
	}
	return found;
}

/**
 * Normalised before parsing, because half these files are CRLF.
 *
 * Not a nicety: matching `\n---\n` against a CRLF file finds the SECOND
 * separator rather than the first, so the header reads as body and the body
 * reads as header. The first version of this script did exactly that and wrote a
 * second front matter block on top of an existing one.
 */
function frontMatter(raw) {
	const source = raw.replace(/\r\n/g, "\n");
	if (!source.startsWith("---\n")) return null;
	const end = source.indexOf("\n---\n", 4);
	if (end === -1) return null;
	const block = {};
	for (const line of source.slice(4, end).split("\n")) {
		const at = line.indexOf(":");
		if (at === -1) continue;
		block[line.slice(0, at).trim()] = line
			.slice(at + 1)
			.trim()
			.replace(/^"(.*)"$/, "$1");
	}
	return block;
}

/**
 * The repositories a task may close in.
 *
 * The work spans two: the engine and the CLI live here, the platform lives in the
 * sibling. A gate that only knew about one would force every task that closed
 * over there to be marked with no commit, which is the exact hole it exists to
 * shut. The sibling is optional, so a checkout with only this repo still works.
 */
const REPOS = [ROOT, join(ROOT, "..", "personaxis")].filter((dir) => {
	try {
		return statSync(join(dir, ".git")) !== null;
	} catch {
		return false;
	}
});

/** Whether a commit exists in either repository. */
function commitExists(sha) {
	if (seen.has(sha)) return true;
	for (const cwd of REPOS) {
		try {
			execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd, stdio: "ignore" });
			seen.add(sha);
			return true;
		} catch {
			// Try the next one. A sha that is in neither is the failure.
		}
	}
	return false;
}

// ── the documents ────────────────────────────────────────────────────────────

let files;
try {
	files = markdownFiles(PLAN);
} catch {
	console.error("No `plan/` here. Run this from the repository root.");
	process.exit(1);
}

const actives = [];

for (const file of files) {
	const name = relative(PLAN, file).replace(/\\/g, "/");
	const source = readFileSync(file, "utf8");
	const head = frontMatter(source);

	if (!head) {
		problems.push(`${name}: no front matter. Needs title, version, date and status.`);
		continue;
	}

	for (const key of ["title", "version", "date", "status"]) {
		if (!head[key]) problems.push(`${name}: missing \`${key}\` in the front matter.`);
	}

	if (head.status && !VALID_STATUS.has(head.status)) {
		problems.push(`${name}: status \`${head.status}\` is not one of ${[...VALID_STATUS].join(", ")}.`);
	}

	// A dated name and a header that disagree is the exact shape of a document
	// that was edited and read as current a month later.
	const dated = DATED.exec(name);
	if (dated && head.date && dated[1] !== head.date) {
		problems.push(`${name}: the name says ${dated[1]} and the header says ${head.date}.`);
	}

	const base = name.split("/").pop();
	if (!dated && SETTLED.has(head.status)) {
		problems.push(`${name}: ${head.status}, so the date belongs in the name.`);
	}

	if (head.status === "superseded" && !head.superseded_by) {
		problems.push(`${name}: superseded by nothing named. Say what replaced it.`);
	}

	// A top-level document that names no parent is claiming to BE a plan. Exactly
	// one may, and a second is how two sessions end up following two plans.
	if (!name.includes("/") && base !== ROOT_DOCUMENT && !head.plan && !SETTLED.has(head.status)) {
		actives.push(name);
	}
}

if (actives.length > 1) {
	problems.push(
		`${actives.length} documents claim to be the plan: ${actives.join(", ")}. ` +
			"All but one need a `plan:` naming their parent.",
	);
}

if (actives.length === 0) {
	problems.push("no live plan. Exactly one top-level document must name no parent.");
}

// ── the ledger ───────────────────────────────────────────────────────────────

const LEDGER_ROW = /^\|\s*([A-Z]+\d+)\s*\|([^|]*)\|\s*(todo|doing|blocked|deferred|done)\s*\|([^|]*)\|([^|]*)\|/;

for (const file of files.filter((path) => path.includes(`${join("runtime", "phases")}`))) {
	const name = relative(PLAN, file).replace(/\\/g, "/");
	for (const line of readFileSync(file, "utf8").split("\n")) {
		const row = LEDGER_ROW.exec(line.trim());
		if (!row) continue;

		const [, id, , state, commitCell, verificationCell] = row;
		if (state !== "done") continue;

		const sha = commitCell.replace(/[`\s]/g, "");
		if (!sha) {
			problems.push(`${name} ${id}: done with no commit. A box ticked by hand is a box that lies.`);
		} else if (!commitExists(sha)) {
			problems.push(`${name} ${id}: commit \`${sha}\` is not in this repository.`);
		}

		if (!verificationCell.trim()) {
			problems.push(`${name} ${id}: done with nothing saying how it was verified.`);
		}
	}
}

// ── the index ────────────────────────────────────────────────────────────────

const indexPath = join(PLAN, "INDEX.md");
let index = "";
try {
	index = readFileSync(indexPath, "utf8");
} catch {
	problems.push("INDEX.md is missing, and it is the entry point after a break.");
}

if (index) {
	for (const file of files) {
		const name = relative(PLAN, file).replace(/\\/g, "/");
		if (name === ROOT_DOCUMENT) continue;

		// Only what somebody might resume from. A superseded document is covered
		// by the archive it sits in, and requiring the index to list every one
		// forever is how an index becomes a file nobody reads.
		const head = frontMatter(readFileSync(file, "utf8"));
		if (head?.status === "superseded" || head?.status === "done") continue;

		// Named by its path, by its basename, or by the folder it sits in. Naming
		// a folder covers what is in it: an index that had to list every file of
		// an archive would be an index nobody reads to the end.
		const base = name.split("/").pop();
		const folder = name.includes("/") ? `${name.slice(0, name.lastIndexOf("/"))}/` : null;
		const named = index.includes(name) || index.includes(base) || (folder && index.includes(folder));
		if (!named) problems.push(`${name}: live, and the index does not name it.`);
	}
}

// ── the verdict ──────────────────────────────────────────────────────────────

if (problems.length === 0) {
	const counted = files.length;
	console.log(`plan: ${counted} documents, one active, ledger consistent with git.`);
	process.exit(0);
}

console.error(`plan: ${problems.length} problem${problems.length === 1 ? "" : "s"}.\n`);
for (const problem of problems) console.error(`  ${problem}`);
console.error("");
process.exit(1);
