#!/usr/bin/env node
// Nothing public points at anything private.
//
//   pnpm check-private
//
// This repository is public and it lives next to work that is not. The private
// material itself is kept out by `.gitignore`, and that part has always held. What
// leaked instead was thinner and easier to miss: POINTERS. A comment saying "see
// docs/<internal>/…", a `package.json` script named after the private ledger, a
// paragraph in CLAUDE.md explaining the private folder's structure to anybody who
// cloned the repo.
//
// Two things make a pointer worth a gate of its own.
//
// It is a dead link for the reader. Somebody clones this, follows the path, and finds
// nothing. A pointer into a folder they cannot have is worse than no pointer, because
// it reads as a promise the project does not keep.
//
// And it travels further than the file. Two of these were inside strings that
// `personaxis init` writes into a USER's `policy.yaml`, and one was inside a schema
// description that ships to npm. By the time the leak is noticed it is on strangers'
// disks and in a published tarball, where no edit here reaches it.
//
// So the rule is checked rather than remembered, and it is checked against what git
// TRACKS rather than what is on disk: a gitignored file may say whatever it likes.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * What counts as private, and why each one is written as a path rather than a word.
 *
 * `plan` and `product` and `research` are ordinary English. A rule that fired on the
 * word would report every sentence containing "the plan" and be switched off within a
 * day, which is the failure mode of every over-eager linter. So each pattern requires
 * the shape of a PATH: the name followed by a slash, at a boundary, and then at least
 * two more characters.
 *
 * The two is not cosmetic. Without it the rule reported `/no plan/i` in a test, where
 * the slash closes a regular expression and the `i` is its flag. One false positive on
 * a line nobody can fix is how a gate loses its authority.
 */
const PRIVATE = [
	{ re: /(?:^|[\s"'`(\[/])(plan\/[A-Za-z0-9_./-]{2,})/, what: "the planning ledger", pathish: true },
	{ re: /(?:^|[\s"'`(\[/])(product\/[A-Za-z0-9_./-]{2,})/, what: "the business folder", pathish: true },
	{ re: /(?:^|[\s"'`(\[/])(research\/[A-Za-z0-9_./-]{2,})/, what: "the research bundle", pathish: true },
	{ re: /personaxis-docs/, what: "the internal documentation" },
	{ re: /docs\/security\//, what: "the security architecture docs" },
	{ re: /FABLE5_BRIEF/, what: "the internal brief" },
	{ re: /SAAS_BUILD_PLAN/, what: "the internal build plan" },
	{ re: /plan:(?:check|next)/, what: "a script named after the private ledger" },
];

/**
 * Whether a `word/word` really is a path, or just two English words with a slash.
 *
 * The three folder names are ordinary words, and English writes alternatives with a
 * slash: "research/marketing/legal use a rubric" is a sentence, not an address. Two
 * false positives have already come from ignoring that, and a gate whose findings
 * nobody can act on gets switched off, taking the real findings with it.
 *
 * A real path here carries at least one of: a dot, a digit, or a capital. Every actual
 * leak found so far has one, and prose alternatives are all-lowercase words.
 *
 * The gap this leaves, stated rather than hidden: an all-lowercase path with no
 * extension slips through. That is the price of not reporting English, and it is the
 * right side to err on, because a gate that cries wolf is a gate somebody deletes.
 * Not "a second slash": `research/marketing/legal` has one and is a sentence.
 */
function looksLikeAPath(match) {
	const tail = match.slice(match.indexOf("/") + 1);
	return /[.0-9A-Z]/.test(tail);
}

/**
 * Files allowed to say these words. There is one, and it is this file.
 *
 * The list above is the only place in a public checkout that names the private work,
 * and it has to be: a checker cannot forbid what it may not name. Once this file was
 * committed it started reporting itself, which is the correct behaviour of the rule
 * and the wrong outcome.
 *
 * The alternative was considered and rejected: move the names into a gitignored
 * supplement so the public script carries none. That buys a public file with nothing
 * private in it and pays for it by leaving CI with nothing to check, on a public
 * checkout where the supplement does not exist. The one pointer that actually reached
 * users was of exactly this kind, so trading the gate for the appearance of one is
 * the wrong trade.
 *
 * And the two are not the same thing. Every other entry here POINTS somewhere: it
 * tells a reader to go and look, and the place is not there. This one prohibits. It
 * says a name must not appear, which is the opposite of an invitation, and it reveals
 * only that private work exists, which is true of every project.
 *
 * One exception, argued here rather than as a quiet `if` in the loop below, which is
 * what an exception list that does not exist gets replaced by under pressure.
 */
const ALLOWED = new Set(["scripts/check-private.mjs"]);

/** Only text. A binary file matching one of these is a coincidence, not a pointer. */
const TEXT = /\.(?:md|mdx|ts|tsx|js|mjs|cjs|json|jsonc|yaml|yml|toml|txt|sh|html|css)$/;

let tracked;
try {
	tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
		.split("\0")
		.filter(Boolean);
} catch {
	console.error("Not a git repository, so there is nothing to check.");
	process.exit(1);
}

const findings = [];

for (const file of tracked) {
	if (!TEXT.test(file) || ALLOWED.has(file)) continue;

	let body;
	try {
		body = readFileSync(file, "utf8");
	} catch {
		// Tracked and unreadable means a deleted file still in the index. Nothing to
		// judge, and refusing to run over it would make this gate fail on a rename.
		continue;
	}

	const lines = body.split(/\r?\n/);
	for (const [index, line] of lines.entries()) {
		for (const { re, what, pathish } of PRIVATE) {
			const hit = re.exec(line);
			if (!hit) continue;
			if (pathish && !looksLikeAPath(hit[1] ?? "")) continue;

			findings.push({ file, line: index + 1, what, text: line.trim().slice(0, 120) });
			break;
		}
	}
}

if (findings.length === 0) {
	console.log(`private: ${tracked.length} tracked files, none points anywhere private.`);
	process.exit(0);
}

console.error(
	`private: ${findings.length} pointer${findings.length === 1 ? "" : "s"} from public files into private work.\n`,
);
for (const f of findings) {
	console.error(`  ${f.file}:${f.line}  (${f.what})`);
	console.error(`    ${f.text}`);
}
console.error(
	"\nSay what the thing IS instead of where it lives. A reader who cannot open the\n" +
		"path is better served by one sentence than by a link that goes nowhere.\n",
);
process.exit(1);
