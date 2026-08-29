/**
 * The package boundary, fixed by a test.
 *
 * Before `exports` existed here, this package shipped its whole `dist` and anybody
 * could reach past the entry point into a file that was never meant to be an API.
 * A boundary that only lives in a comment is a boundary that erodes.
 *
 * The interesting half is the other one. Adding a bare `{ ".": "./dist/index.js" }`
 * would have been the obvious change and it would have broken **five places in the
 * SaaS**, silently and only at runtime: three read
 * `@personaxis/spec/schema/persona.schema.json` and two resolve
 * `@personaxis/spec/package.json`. Node blocks both once `exports` is present unless
 * they are declared, and `package.json` in particular is a subpath people forget is a
 * subpath.
 *
 * So this file says what the boundary lets through and what it does not, and it fails
 * in whichever direction somebody breaks it: opening the internals, or closing a door
 * the consumers already walk through.
 */

import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);

/** What the outside is allowed to reach, and who reaches it. */
const OPEN = [
	["@personaxis/spec", "the entry point"],
	["@personaxis/spec/package.json", "resolved by the SaaS in two places"],
	["@personaxis/spec/schema/persona.schema.json", "read by the SaaS in three places"],
	["@personaxis/spec/schema/legacy/persona-0.10.schema.json", "a nested schema path"],
] as const;

/** What the outside must not reach, whatever it is called today. */
const CLOSED = [
	"@personaxis/spec/dist/index.js",
	"@personaxis/spec/src/index.ts",
] as const;

describe("the spec package boundary", () => {
	for (const [specifier, why] of OPEN) {
		it(`lets through ${specifier}, ${why}`, () => {
			expect(() => require_.resolve(specifier)).not.toThrow();
		});
	}

	for (const specifier of CLOSED) {
		it(`does not let through ${specifier}`, () => {
			expect(() => require_.resolve(specifier)).toThrow();
		});
	}

	it("declares exports at all, which is what makes the two lists above mean anything", () => {
		const pkg = require_("../package.json") as { exports?: Record<string, unknown> };
		expect(pkg.exports).toBeDefined();
		// Named explicitly rather than counted, so removing one is a failure that says
		// which one, not an arithmetic surprise.
		expect(Object.keys(pkg.exports ?? {})).toEqual(
			expect.arrayContaining([".", "./schema/*", "./package.json"]),
		);
	});
});
