/**
 * The check a deliverable carries with it.
 *
 * ## Why this exists
 *
 * E85, 2026-09-15. A turn that wrote a page said it was done, and nothing ran the page. That is how a review
 * that could only READ approved a game that died five seconds in (`E71`), and how three service runs said the
 * work was finished while the step that had to execute the page could not (`E98`). The fix is not a new gate
 * somebody has to declare: it is that some deliverables have an obvious check, and the loop runs it.
 *
 * ## What it will and will not do
 *
 * A page is executed. A JSON file is parsed. Anything else has no obvious check and is reported as unverified
 * BY NAME, because an absence nobody names reads as verified, which is the state the note this comes from
 * insists has to be observable.
 *
 * Nothing here judges quality. A page that runs can still be a bad game, and saying "it runs" is exactly as
 * much as running it proves. Whatever the persona declares in its own `verification` block runs after this and
 * is not replaced by it.
 *
 * Every check is `targeted`: it is about one file. It never climbs to a claim about the workspace, which is the
 * promotion the note calls the lie an attestation cannot afford.
 */

import { readFileSync } from "node:fs";
import { extname } from "node:path";

import { renderPageRun, runPage } from "../web/run-page.js";

/** How long a page is run for, in seconds of frames, which is what `check_page` offers a persona by default. */
const PAGE_SECONDS = 10;
const FPS = 60;

export interface DerivedCheck {
	/** The file, as it was named when it was written. */
	readonly what: string;
	/** What was run, in words a person reads. */
	readonly how: string;
	readonly passed: boolean;
	readonly reason?: string;
	readonly scope: "targeted";
}

export interface DerivedResult {
	readonly checks: DerivedCheck[];
	/** Deliverables with no obvious check, named one by one. */
	readonly unverified: string[];
}

/**
 * What the loop reports about what a turn left: the same shape, as the seam and the record carry it.
 *
 * Named apart from `DerivedResult` because this one crosses a boundary: the loop produces it, the turn seam
 * hands it on, and the record writes it. A shape that travels is worth a name of its own.
 */
export type DeliveredVerification = DerivedResult;

/** Whether this file has a check that follows from what it is. Internal: what it decides is visible in the result. */
function hasDerivedCheck(path: string): boolean {
	const ext = extname(path).toLowerCase();
	return ext === ".html" || ext === ".htm" || ext === ".json";
}

function checkPage(path: string, html: string): DerivedCheck {
	const run = runPage(html, { frames: PAGE_SECONDS * FPS });
	return {
		what: path,
		how: `ran it for ${PAGE_SECONDS} seconds of frames`,
		passed: run.ok,
		// The tool's own words, so a person reads the same sentence here and in a turn that called check_page.
		...(run.ok ? {} : { reason: renderPageRun(path, run, PAGE_SECONDS).split("\n")[0] ?? "it does not run" }),
		scope: "targeted",
	};
}

function checkJson(path: string, text: string): DerivedCheck {
	try {
		JSON.parse(text);
		return { what: path, how: "parsed it as JSON", passed: true, scope: "targeted" };
	} catch (e) {
		return { what: path, how: "parsed it as JSON", passed: false, reason: (e as Error).message.slice(0, 160), scope: "targeted" };
	}
}

/**
 * Run what follows from each deliverable, and name what has no check.
 *
 * `read` is injected so a test does not need a disk and a run reads the file as it stands at the end of the
 * turn, which is the version the answer is about. A file that cannot be read is a failed check and not a
 * missing one: it was written during this turn, so something is wrong if it is gone.
 */
export function runDerivedChecks(paths: readonly string[], read: (path: string) => string = (path) => readFileSync(path, "utf8")): DerivedResult {
	const checks: DerivedCheck[] = [];
	const unverified: string[] = [];

	for (const path of paths) {
		if (!hasDerivedCheck(path)) {
			unverified.push(path);
			continue;
		}
		let text: string;
		try {
			text = read(path);
		} catch (e) {
			checks.push({ what: path, how: "opened it", passed: false, reason: (e as Error).message.slice(0, 160), scope: "targeted" });
			continue;
		}
		checks.push(extname(path).toLowerCase() === ".json" ? checkJson(path, text) : checkPage(path, text));
	}

	return { checks, unverified };
}
