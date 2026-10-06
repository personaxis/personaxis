/**
 * The two small helpers of the wire contract that nothing in this package called.
 *
 * `wireAuthorId` has to read an author exactly the way the engine's `authorId` does,
 * or two records of the same act stop comparing equal. `isWireEventKind` is the guard
 * a consumer switches on. Both are exported and both are used outside this package,
 * which is why they were never exercised here.
 */

import { describe, expect, it } from "vitest";

import { isWireEventKind, wireAuthorId, type WireEvent } from "../src/workspace.js";

describe("wireAuthorId", () => {
	it("reads every kind of author the same way the engine does", () => {
		expect(wireAuthorId({ kind: "human", id: "u-1" })).toBe("human:u-1");
		expect(wireAuthorId({ kind: "persona", id: "clio" })).toBe("persona:clio");
		expect(wireAuthorId({ kind: "component", name: "gate" })).toBe("component:gate");
		expect(wireAuthorId({ kind: "runtime", mechanism: "compaction", reason: "window full" })).toBe("runtime:compaction");
	});

	it("gives two different authors two different ids", () => {
		expect(wireAuthorId({ kind: "human", id: "a" })).not.toBe(wireAuthorId({ kind: "persona", id: "a" }));
	});
});

describe("isWireEventKind", () => {
	it("narrows on the kind and nothing else", () => {
		const event = { kind: "persona.session.started" } as unknown as WireEvent;
		expect(isWireEventKind(event, "persona.session.started" as never)).toBe(true);
		expect(isWireEventKind(event, "persona.session.ended" as never)).toBe(false);
	});
});
