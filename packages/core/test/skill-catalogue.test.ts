/**
 * What is offered, what is not, and why the reason is the useful half.
 */

import { describe, expect, it } from "vitest";

import {
	catalogue,
	loadableOnRequest,
	mayRewrite,
	type CatalogueContext,
	type SkillEntry,
} from "../src/run/index.js";

const here: CatalogueContext = { platform: "linux", environments: ["repo"] };

const skill = (over: Partial<SkillEntry> = {}): SkillEntry => ({
	name: "deploy",
	tier: "profile",
	scan: "clean",
	provenance: { by: "person", id: "david" },
	...over,
});

describe("a scan that did not conclude does not let a skill load", () => {
	it("quarantines a dangerous verdict", () => {
		const view = catalogue([skill({ scan: "dangerous" })], here);

		expect(view.offered).toEqual([]);
		expect(view.withheld[0]!.reason).toEqual({ why: "quarantined", verdict: "dangerous" });
	});

	it("quarantines an unscanned one, which is the fail-closed half", () => {
		// Content from a repository with no completed scan is not content anybody
		// vouched for, and a missing scanner must not read as a pass.
		expect(catalogue([skill({ scan: "unscanned" })], here).offered).toEqual([]);
	});

	it("lets a caution through, because a quarantine that fires on a word quarantines everything", () => {
		expect(catalogue([skill({ scan: "caution" })], here).offered).toHaveLength(1);
	});
});

describe("precedence is explicit, and what it shadows says so", () => {
	it("lets a project skill win over a bundled one of the same name", () => {
		const view = catalogue(
			[skill({ tier: "bundled" }), skill({ tier: "project" })],
			here,
		);

		expect(view.offered[0]!.tier).toBe("project");
		expect(view.withheld[0]!.reason).toEqual({ why: "shadowed", by: "project" });
	});

	it("reports the shadowed one rather than dropping it", () => {
		// A name silently resolving somewhere else is the surprise a precedence rule
		// exists to make explicit.
		const view = catalogue([skill({ tier: "project" }), skill({ tier: "external" })], here);

		expect(view.withheld).toHaveLength(1);
	});
});

describe("relevance, compatibility and permission are three different axes", () => {
	it("withholds one for another platform, and says which platform this is", () => {
		const view = catalogue([skill({ platforms: ["win32"] })], here);

		expect(view.withheld[0]!.reason).toEqual({ why: "wrong_platform", platform: "linux" });
	});

	it("withholds one that is merely not relevant here", () => {
		const view = catalogue([skill({ environments: ["kanban"] })], here);

		expect(view.withheld[0]!.reason.why).toBe("not_relevant");
	});

	it("withholds one outside what the persona declared, which nobody else can ask", () => {
		const view = catalogue([skill()], {
			...here,
			withinEnvelope: () => ({ ok: false, reason: "this persona does not deploy" }),
		});

		expect(view.withheld[0]!.reason).toEqual({
			why: "outside_envelope",
			reason: "this persona does not deploy",
		});
	});

	it("asks the envelope before relevance, because a limit outranks noise", () => {
		const view = catalogue([skill({ environments: ["kanban"] })], {
			...here,
			withinEnvelope: () => ({ ok: false, reason: "out of character" }),
		});

		expect(view.withheld[0]!.reason.why).toBe("outside_envelope");
	});
});

describe("asking explicitly is consenting, but only to noise", () => {
	it("loads one withheld only for relevance", () => {
		expect(loadableOnRequest({ why: "not_relevant", environment: "repo" })).toBe(true);
	});

	it("does not load a quarantined one, a foreign-platform one, or one out of envelope", () => {
		expect(loadableOnRequest({ why: "quarantined", verdict: "dangerous" })).toBe(false);
		expect(loadableOnRequest({ why: "wrong_platform", platform: "linux" })).toBe(false);
		expect(loadableOnRequest({ why: "outside_envelope", reason: "x" })).toBe(false);
	});
});

describe("only what the persona wrote may the persona rewrite", () => {
	it("lets it rewrite its own", () => {
		expect(mayRewrite(skill({ provenance: { by: "persona", id: "clio" } }), "clio")).toBe(true);
	});

	it("refuses another persona's, a person's, and a vendor's", () => {
		expect(mayRewrite(skill({ provenance: { by: "persona", id: "cmo" } }), "clio")).toBe(false);
		expect(mayRewrite(skill({ provenance: { by: "person", id: "david" } }), "clio")).toBe(false);
		expect(mayRewrite(skill({ provenance: { by: "vendor" } }), "clio")).toBe(false);
	});

	it("treats an unknown owner exactly as an absent one, and refuses both", () => {
		// Their bug generalised: keying on whether a record existed, when the authorised
		// write created that record, allowed each write exactly once.
		expect(mayRewrite(skill({ provenance: { by: "unknown" } }), "clio")).toBe(false);
	});
});
