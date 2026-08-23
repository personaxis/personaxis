/**
 * Where a run happens, and what it may touch while it is there.
 *
 * The two claims worth checking are that a split world is refused rather than tolerated,
 * and that nothing here decides anything about a call. The gate decided already.
 */

import { describe, expect, it } from "vitest";

import {
	applyWith,
	canHandOver,
	choose,
	coherent,
	describeRefusal,
	effectiveMode,
	egressAllowed,
	narrower,
	type BackendReport,
	type ConfinementPolicy,
	type World,
} from "../src/worlds/index.js";

const policy = (over: Partial<ConfinementPolicy> = {}): ConfinementPolicy => ({
	mode: "workspace-write",
	writableRoots: ["/work/repo"],
	egressAllowlist: ["api.example.com"],
	...over,
});

const backend: BackendReport = { name: "bwrap", completeness: "complete", gaps: [] };

const world = (over: Partial<World> = {}): World => ({
	kind: "machine",
	label: "davids-laptop",
	seams: { files: "local", processes: "local" },
	backend,
	...over,
});

describe("a world is a group of seams, swapped as a group", () => {
	it("accepts one whose seams come from the same place", () => {
		expect(coherent(world())).toBe(true);
	});

	it("refuses one that is half remote, because that is two worlds", () => {
		// A deployment with a remote file provider and a local process provider is not
		// a hybrid: the persona lives in whichever one the last call happened to reach.
		const split = world({ seams: { files: "hosted", processes: "local" } });

		const result = choose(split, policy());

		expect(result.ok).toBe(false);
		expect(!result.ok && result.refusal.why).toBe("split_world");
	});

	it("says what the two halves were, rather than that something is wrong", () => {
		const split = world({ seams: { files: "hosted", processes: "local" } });
		const result = choose(split, policy());

		expect(!result.ok && describeRefusal(result.refusal)).toContain("hosted");
		expect(!result.ok && describeRefusal(result.refusal)).toContain("local");
	});
});

describe("there is no unconfined passthrough", () => {
	it("refuses a confined mode with nothing to confine it", () => {
		// Running unconfined while believing otherwise is worse than not running.
		const result = choose(world({ backend: undefined }), policy());

		expect(!result.ok && result.refusal.why).toBe("no_confinement");
	});

	it("needs no backend for a mode that confines nothing, and claims none", () => {
		const decision = applyWith(policy({ mode: "full" }), undefined);

		expect(decision).toEqual({ ok: true, completeness: "complete", gaps: [] });
	});

	it("reports a partial backend as partial, and names the gap", () => {
		// Saying "this restricts writes and not reads or network" out loud is worth more
		// than the restriction it is admitting to.
		const decision = applyWith(policy(), {
			name: "windows-acl",
			completeness: "partial",
			gaps: ["reads", "network"],
		});

		expect(decision).toEqual({ ok: true, completeness: "partial", gaps: ["reads", "network"] });
	});

	it("refuses when no backend exists at all", () => {
		expect(applyWith(policy(), undefined).ok).toBe(false);
	});
});

describe("the mode is a fold, and combining never widens", () => {
	it("takes the last one set", () => {
		expect(
			effectiveMode(
				[
					{ mode: "read-only", by: "operator" },
					{ mode: "workspace-write", by: "operator" },
				],
				"full",
			),
		).toBe("workspace-write");
	});

	it("falls to the declared default when nothing was ever set", () => {
		expect(effectiveMode([], "read-only")).toBe("read-only");
	});

	it("narrows rather than widens, whichever order the two arrive in", () => {
		expect(narrower("full", "read-only")).toBe("read-only");
		expect(narrower("read-only", "full")).toBe("read-only");
		expect(narrower("workspace-write", "full")).toBe("workspace-write");
	});
});

describe("egress is denial by default and matches on the host", () => {
	it("allows an exact host and a subdomain of one", () => {
		expect(egressAllowed("api.example.com", policy())).toBe(true);
		expect(egressAllowed("eu.api.example.com", policy())).toBe(true);
	});

	it("refuses anything not listed, because absence is denial", () => {
		expect(egressAllowed("evil.com", policy())).toBe(false);
	});

	it("refuses a host that merely ends with the allowed text, without the dot", () => {
		// A substring check turns an allowlist into a suffix somebody can append to
		// their own domain.
		expect(egressAllowed("notapi.example.com.evil.com", policy())).toBe(false);
		expect(egressAllowed("myapi.example.com", { ...policy(), egressAllowlist: ["api.example.com"] })).toBe(
			false,
		);
	});

	it("refuses everything when the list is empty", () => {
		expect(egressAllowed("api.example.com", policy({ egressAllowlist: [] }))).toBe(false);
	});
});

describe("work does not silently move between machines", () => {
	it("lets a step carry on in the same world", () => {
		expect(canHandOver(world(), world(), undefined)).toEqual({ ok: true });
	});

	it("lets the first step start anywhere", () => {
		expect(canHandOver(undefined, world(), undefined)).toEqual({ ok: true });
	});

	it("refuses a step that would start where its predecessor's files are not", () => {
		// The refusal is the honest shape of a missing feature: it is named, a workspace
		// can show it, and it disappears the day a transport exists.
		const result = canHandOver(world(), world({ label: "hosted-1" }), undefined);

		expect("ok" in result && result.ok).toBe(false);
	});

	it("says both machines by name, so somebody can see what would have moved", () => {
		const result = canHandOver(world(), world({ label: "hosted-1" }), undefined);

		expect(
			!("refusal" in result) ? "" : describeRefusal(result.refusal),
		).toContain("davids-laptop");
	});

	it("allows it once a transport exists, without anything else changing", () => {
		expect(canHandOver(world(), world({ label: "hosted-1" }), {})).toEqual({ ok: true });
	});
});
