// What `personaxis pull` will accept, and what it must keep accepting.
//
// The registry used to serve one namespace, the official one, while `push` wrote
// into the caller's. You could publish a persona and then nobody could download
// it. Adding `@namespace/slug` is what closes that, and the first thing it must
// not do is change what the bare form already means to installs in the wild.

import { describe, expect, it } from "vitest";

import { parsePersonaRef } from "../src/commands/pull.js";

describe("parsePersonaRef", () => {
	it("keeps the bare slug meaning the official catalogue", () => {
		// `personaxis pull maven` exists in published installs. Resolving it
		// anywhere else would break them silently, which is the worst way.
		expect(parsePersonaRef("maven")).toEqual(["maven"]);
		expect(parsePersonaRef("code_reviewer")).toEqual(["code_reviewer"]);
		expect(parsePersonaRef("a-b-c")).toEqual(["a-b-c"]);
	});

	it("reads a namespaced reference as two segments", () => {
		// Two segments and not one encoded string: an encoded slash depends on
		// every proxy in between leaving it alone.
		expect(parsePersonaRef("@david/maven")).toEqual(["@david", "maven"]);
	});

	it.each([
		["an empty reference", ""],
		["a namespace with no persona", "@david"],
		["a namespace with an empty persona", "@david/"],
		["a persona with an empty namespace", "@/maven"],
		["a third segment", "@david/maven/extra"],
		["an uppercase slug", "Maven"],
		["a slug starting with a dash", "-maven"],
		["a path traversal", "../../etc/passwd"],
		["a slug that is too long", "m".repeat(101)],
		["a namespace that is too long", `@${"d".repeat(101)}/maven`],
	])("refuses %s", (_label, reference) => {
		expect(parsePersonaRef(reference)).toBeNull();
	});

	it("refuses a bare reference that only looks namespaced", () => {
		// A slash with no leading @ is not a namespace, it is a path, and a path
		// is what an attacker sends when they are hoping the server joins strings.
		expect(parsePersonaRef("david/maven")).toBeNull();
	});
});
