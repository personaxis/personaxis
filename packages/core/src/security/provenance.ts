/**
 * Integrity and provenance for anything a persona runs that it did not author.
 *
 * A skill is code. An MCP server is a process with tools the persona will call.
 * Both arrive by reference, both are materialised into a directory the host
 * agent discovers, and until now neither was verified: a persona that declared
 * `skills: [github:org/repo]` got whatever that path contained at the moment it
 * was fetched, and nothing recorded what that was.
 *
 * That is the supply chain question, and the answer here is deliberately modest,
 * because an ambitious one would be worse than none:
 *
 *   It does NOT verify that a skill is safe. Nothing can.
 *   It DOES record exactly what was materialised, so a change is visible.
 *   It DOES refuse to run something whose content no longer matches what was
 *   approved, which is the only property that turns a review into a control.
 *
 * The hash covers the content, not the reference. A reference is a promise about
 * where something lives; a hash is a statement about what it is, and a tag that
 * moved is precisely the case this exists to catch.
 */

import { createHash } from "node:crypto";

/** What a materialised artifact is, and what it was when someone looked at it. */
export interface Provenance {
	/** As declared: `@org/name@1.2.3`, `github:org/repo/path`, or a local path. */
	ref: string;
	/** sha256 over the canonical content listing. Hex. */
	contentHash: string;
	/** How many files the hash covers. A count of zero is a fetch that failed quietly. */
	fileCount: number;
	/** When it was materialised, ISO-8601. */
	materialisedAt: string;
}

/** One file's contribution to the hash. */
export interface ContentEntry {
	/** Path relative to the artifact root, with forward slashes. */
	path: string;
	/** The bytes. */
	content: string;
}

/**
 * Hashes a set of files as one artifact.
 *
 * Sorted by path and length-prefixed. Sorting makes the hash independent of the
 * order a directory walk happened to return, which differs between platforms
 * and would otherwise make a hash unreproducible on a colleague's machine.
 * Length-prefixing stops two different file sets from hashing the same by
 * shifting a byte across a boundary: without it, `{a: "xy"}` and `{ax: "y"}`
 * would produce identical input.
 */
export function hashContent(entries: readonly ContentEntry[]): string {
	const hash = createHash("sha256");

	const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

	for (const entry of sorted) {
		const path = entry.path.replace(/\\/g, "/");
		hash.update(`${path.length}:${path}`);
		hash.update(`${Buffer.byteLength(entry.content)}:`);
		hash.update(entry.content);
	}

	return hash.digest("hex");
}

export type IntegrityVerdict =
	| { ok: true }
	| { ok: false; reason: string; expected: string; actual: string };

/**
 * Whether what is on disk is still what was approved.
 *
 * The message names both hashes rather than saying "mismatch", because the
 * person reading it has to decide whether they moved a tag on purpose or
 * something else did.
 */
export function verifyIntegrity(
	recorded: Provenance,
	entries: readonly ContentEntry[],
): IntegrityVerdict {
	const actual = hashContent(entries);
	if (actual === recorded.contentHash) return { ok: true };

	return {
		ok: false,
		reason:
			entries.length === 0
				? `${recorded.ref} resolved to nothing. It was ${recorded.fileCount} file(s) when it was approved.`
				: `${recorded.ref} has changed since it was approved (${recorded.fileCount} file(s) then, ${entries.length} now).`,
		expected: recorded.contentHash,
		actual,
	};
}

/**
 * Whether a reference pins a specific version.
 *
 * An unpinned reference is not refused here, because refusing would make the
 * common case impossible before anybody has a lockfile. It is reported, so the
 * surface that shows a persona's skills can say which ones can change under it
 * without anyone doing anything.
 */
export function isPinned(ref: string): boolean {
	// A local path is as pinned as the working tree, which is the same trust
	// level as the persona document sitting next to it.
	if (ref.startsWith(".") || ref.startsWith("/") || /^[A-Za-z]:[\\/]/.test(ref)) return true;

	// `@org/name@1.2.3` but not `@org/name` or `@org/name@latest`.
	if (ref.startsWith("@")) {
		const version = ref.slice(1).split("@")[1];
		return Boolean(version) && version !== "latest" && !version.startsWith("^") && !version.startsWith("~");
	}

	// `github:org/repo@<40 hex>` is pinned; a branch or a tag is not, because
	// both move and a tag moving is exactly what the hash exists to catch.
	if (ref.startsWith("github:")) return /@[0-9a-f]{40}$/.test(ref);

	return false;
}

/** A one-line description of what a reference commits to, for a surface to show. */
export function describePinning(ref: string): string {
	return isPinned(ref)
		? "pinned"
		: "not pinned: this can change under you without anyone acting";
}
