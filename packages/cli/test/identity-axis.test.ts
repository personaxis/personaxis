/**
 * The second axis, on the road rather than in a fixture.
 *
 * `gate/identity.ts` has its own tests and they pass. It had zero consumers, so what
 * they proved was that a function returns the right value when a test calls it. This
 * file is about the other thing: that the daemon asks it, about a real call, with a
 * real envelope read off a real disk, and refuses.
 *
 * Every test here is written as the negative control it has to survive. The failure
 * mode this axis invites is silence, because an axis with nothing to weigh looks
 * exactly like an axis that found nothing wrong, and the difference is the whole
 * product. So each one is paired: the call that must be refused, and the neighbouring
 * call that must not be, because a guard that refuses everything is as useless as one
 * that refuses nothing and is much easier to write by accident.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { enforcementHandler } from "../src/workspace/enforcement-service.js";
import {
	declaredValues,
	identityOver,
	identityPolicyFor,
	namesState,
	postureOf,
	rootFor,
} from "../src/workspace/identity-axis.js";
import { PolicyCache } from "../src/workspace/policy-cache.js";

const made: string[] = [];

afterEach(() => {
	while (made.length > 0) {
		const dir = made.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

/**
 * A consented directory with a persona in it.
 *
 * Written to disk rather than mocked, because the thing being tested is that the
 * daemon reads what an operator actually has: a `personaxis.md` whose frontmatter
 * declares the envelope, and a `state.json` saying where the coordinates sit. A fake
 * of either one would let the axis pass while the file layout it depends on was
 * wrong, and the file layout is the part nothing else checks.
 */
function workspaceWith(options: {
	mode?: string;
	values?: Record<string, number>;
	hardVirtue?: boolean;
}): string {
	const root = mkdtempSync(join(tmpdir(), "identity-axis-"));
	made.push(root);
	mkdirSync(join(root, ".personaxis"), { recursive: true });

	// The dot-path form the template documents, `refs: ["personality.traits.x"]`.
	// Written short at first, and it did not protect anything: `resolveField` maps the
	// legacy `traits.` prefix onto the full one and has no rule for a bare name, so the
	// reference resolved to a key no envelope had. The composition rule was fine; the
	// fixture was not.
	const virtue = options.hardVirtue
		? 'character:\n  virtues:\n    honesty:\n      enforcement: hard\n      refs: ["personality.traits.honesty_humility"]\n'
		: "";

	writeFileSync(
		join(root, ".personaxis", "personaxis.md"),
		"---\n" +
			'spec_version: "1.1.0"\n' +
			"identity:\n  name: Tester\n" +
			`improvement_policy:\n  mode: ${options.mode ?? "suggesting"}\n` +
			"personality:\n" +
			"  traits:\n" +
			"    honesty_humility:\n      mean: 0.7\n      range: [0.5, 0.9]\n" +
			"    openness:\n      mean: 0.5\n      range: [0.0, 1.0]\n" +
			virtue +
			"---\n\nA persona.\n",
		"utf-8",
	);

	writeFileSync(
		join(root, ".personaxis", "state.json"),
		JSON.stringify({
			schema_version: "1.0.0",
			persona_id: "p",
			persona_version: "1",
			values: options.values ?? { "personality.traits.honesty_humility": 0.7 },
			mutation_log: [],
		}),
		"utf-8",
	);

	return root;
}

/** The daemon, built the way `connect` builds it, over one consented directory. */
function daemon(root: string, overrides: Record<string, unknown> = {}) {
	const cache = new PolicyCache();
	cache.put({
		persona_version_id: "pv_1",
		hash: "h",
		compiled_at: new Date().toISOString(),
		ttl_seconds: 3600,
		deny: [],
		allow: [],
		hard_limits: [],
		prohibited_behaviors: [],
		egress_allowlist: [],
		// The first axis wide open, deliberately.
		//
		// With `workspace-write` and no gate rule for `external_write`, the capability
		// axis refuses every write on its own, and each assertion below would pass
		// while proving nothing about identity. Measured while writing this file: the
		// first four tests went green against `sandbox:workspace-write`. A test that
		// passes for the wrong reason is worse than one that fails.
		sandbox: "danger-full-access",
		approval: "never",
		gate_rules: [],
	} as never);

	return enforcementHandler({
		cache,
		scope: [root],
		personaVersionFor: () => "pv_1",
		identity: identityOver([root]),
		...overrides,
	} as never);
}

/** A write of the whole state document, the way a host's file tool sends one. */
function writeOf(root: string, values: Record<string, number>) {
	return {
		tool_name: "Write",
		args_text: JSON.stringify({
			content: JSON.stringify({
				schema_version: "1.0.0",
				persona_id: "p",
				persona_version: "1",
				values,
				mutation_log: [],
			}),
			file_path: join(root, ".personaxis", "state.json"),
		}),
		cwd: root,
	};
}

describe("a call that would leave the persona outside its declared envelope", () => {
	it("is refused by the daemon, naming the coordinate and the bound", async () => {
		// The one that matters. `governMutations` clamps to the envelope, and a file
		// write goes around it entirely: an agent that wants to raise its own autonomy
		// does not call `state mutate`, it writes the file.
		const root = workspaceWith({});
		const reply = await daemon(root)(
			writeOf(root, { "personality.traits.honesty_humility": 0.99 }),
		);

		expect(reply.verdict).toBe("deny");
		expect(reply.rule).toBe("envelope:personality.traits.honesty_humility");
		expect(reply.reason).toContain("0.99");
		expect(reply.reason).toContain("0.9");
	});

	it("allows the same write when the value stays inside its band", async () => {
		// The negative control for the test above. Without it, a guard that refused
		// every write to the state file would pass it, and the axis would be an
		// unconditional denial wearing the name of a measurement.
		const root = workspaceWith({});
		const reply = await daemon(root)(
			writeOf(root, { "personality.traits.honesty_humility": 0.72 }),
		);

		expect(reply.verdict).toBe("allow");
	});

	it("says nothing about a coordinate the persona never declared", async () => {
		// `identity.ts` opens with this: an undeclared coordinate is not silently fine,
		// it is not this axis's question. A guard that refused it would be answering
		// confidently about something nobody wrote down.
		const root = workspaceWith({});
		const reply = await daemon(root)(writeOf(root, { "personality.traits.invented": 9000 }));

		expect(reply.verdict).toBe("allow");
	});
});

describe("a band crossing, which is the layer's to govern", () => {
	it("is refused under a locked persona, and names the band it would leave", async () => {
		// `locked` means only a human-directed mutation passes, and a call arriving at
		// the hook is not one.
		const root = workspaceWith({
			mode: "locked",
			values: { openness: 0.5, "personality.traits.openness": 0.5 },
		});
		const reply = await daemon(root)(writeOf(root, { "personality.traits.openness": 0.9 }));

		expect(reply.verdict).toBe("deny");
		expect(reply.rule).toBe("band:personality.traits.openness");
		expect(reply.reason).toContain("moderate");
		expect(reply.reason).toContain("high");
	});

	it("is let through under an autonomous persona", async () => {
		// The negative control for the posture itself. If the mode were ignored, this
		// would be refused too and the three postures would be one.
		const root = workspaceWith({
			mode: "autonomous",
			values: { "personality.traits.openness": 0.5 },
		});
		const reply = await daemon(root)(writeOf(root, { "personality.traits.openness": 0.9 }));

		expect(reply.verdict).toBe("allow");
	});

	it("is refused for want of anyone to ask under a suggesting persona", async () => {
		// An ask with no gate rule configured is a refusal, and the axis's own words
		// travel with it. That branch used to be defensive, on the grounds that only
		// the policy raised asks. This is what made it a real case.
		const root = workspaceWith({
			mode: "suggesting",
			values: { "personality.traits.openness": 0.5 },
		});
		const reply = await daemon(root)(writeOf(root, { "personality.traits.openness": 0.9 }));

		expect(reply.verdict).toBe("deny");
		expect(reply.reason).toContain("a person decides");
		expect(reply.reason).toContain("no gate rule");
	});

	it("locks a field a hard-enforced virtue protects, whatever the mode says", async () => {
		// The composition rule: `honesty` with hard enforcement protects the trait it
		// references. An autonomous persona still may not move it, and without this the
		// fallback would quietly govern every field alike.
		const root = workspaceWith({
			mode: "autonomous",
			hardVirtue: true,
			values: { "personality.traits.honesty_humility": 0.55 },
		});
		const reply = await daemon(root)(
			writeOf(root, { "personality.traits.honesty_humility": 0.85 }),
		);

		expect(reply.verdict).toBe("deny");
		expect(reply.reason).toContain("governance controlled");
	});
});

describe("a write this machine cannot read", () => {
	it("is refused rather than waved through", async () => {
		// A partial edit of the state file, which is what `Edit` sends, and what the ACP
		// path produces on its own for any state document over four thousand
		// characters. An empty effect list is indistinguishable to the identity guard
		// from a call that touches nothing, which is why this is a guard of its own.
		const root = workspaceWith({});
		const reply = await daemon(root)({
			tool_name: "Edit",
			args_text: JSON.stringify({
				file_path: join(root, ".personaxis", "state.json"),
				new_string: '"honesty_humility": 0.99',
				old_string: '"honesty_humility": 0.7',
			}),
			cwd: root,
		});

		expect(reply.verdict).toBe("deny");
		expect(reply.rule).toBe("state_write_unreadable");
		expect(reply.reason).toContain("cannot read");
	});

	it("does not refuse a READ of the same file", async () => {
		// The control that decides whether this guard is usable. A reader that fired on
		// any mention of the path would refuse every look at the persona's own state,
		// and somebody would turn the daemon off within a day.
		const root = workspaceWith({});
		const reply = await daemon(root)({
			tool_name: "Read",
			args_text: JSON.stringify({ file_path: join(root, ".personaxis", "state.json") }),
			cwd: root,
		});

		expect(reply.verdict).toBe("allow");
	});

	it("does not refuse a write to a different state.json", async () => {
		// The path is compared, not the file name. Plenty of projects have a state.json
		// that has nothing to do with a persona.
		const root = workspaceWith({});
		const reply = await daemon(root)({
			tool_name: "Write",
			args_text: JSON.stringify({
				content: "{}",
				file_path: join(root, "src", "state.json"),
			}),
			cwd: root,
		});

		expect(reply.verdict).toBe("allow");
	});
});

describe("what the axis says when it has nothing to measure against", () => {
	it("returns nothing for a directory with no persona, rather than an empty envelope", async () => {
		// Null is not an allow. It means the identity question has no referent here, and
		// the rest of the cascade already refuses such a directory under its own name.
		// An empty envelope would be an axis that permits everything while looking like
		// it was measuring something.
		const root = mkdtempSync(join(tmpdir(), "identity-axis-bare-"));
		made.push(root);

		expect(identityPolicyFor(root)).toBeNull();
		expect(identityOver([root])({ tool_name: "Write", args_text: "{}", cwd: root }, [])).toBeNull();
	});

	it("returns nothing for a spec that declares no envelopes", () => {
		const root = mkdtempSync(join(tmpdir(), "identity-axis-empty-"));
		made.push(root);
		mkdirSync(join(root, ".personaxis"), { recursive: true });
		writeFileSync(
			join(root, ".personaxis", "personaxis.md"),
			"---\nidentity:\n  name: Bare\n---\n\nNothing declared.\n",
			"utf-8",
		);

		expect(identityPolicyFor(root)).toBeNull();
	});

	it("keeps the range when the state file is unreadable, and loses only the crossings", async () => {
		// Half the knowledge rather than none. Without a current value `examine` falls
		// back to the envelope's mean, so a crossing becomes unreliable and the range
		// does not, and giving up the range as well would be the wrong half to drop.
		const root = workspaceWith({});
		writeFileSync(join(root, ".personaxis", "state.json"), "{ torn", "utf-8");

		const policy = identityPolicyFor(root);
		expect(policy?.current).toEqual({});

		const reply = await daemon(root)(
			writeOf(root, { "personality.traits.honesty_humility": 0.99 }),
		);
		expect(reply.verdict).toBe("deny");
		expect(reply.rule).toBe("envelope:personality.traits.honesty_humility");
	});
});

describe("what the axis costs, since it reads a disk on the hot path", () => {
	it("costs a bounded MULTIPLE of the same decision without it", async () => {
		// `workspace-gate-regression.test.ts` says the headroom over the 150 ms budget
		// "is exactly what invites somebody to put a file read or a network call in a
		// guard", and this axis is somebody doing that: a spec and a state file, read on
		// every call, because both move and a cached copy would refuse work the files on
		// disk already permit.
		//
		// So it gets measured rather than assumed. Measured on 2026-09-04, over 200
		// decisions against a persona on disk: p95 0.52 ms, mean 0.35 ms. A third of one
		// percent of the budget.
		//
		// ## Why this asserts a RATIO and not a millisecond count
		//
		// It asserted `p95 < 5ms` first, and that version passed alone and failed inside
		// the full suite: eight vitest workers on one laptop, and a number that is fine
		// on an idle machine is not fine on a busy one. A test that fails because the
		// machine was loaded teaches people to rerun instead of read, which is exactly
		// how a real failure gets waved through.
		//
		// So both halves are measured in the same loop, on the same machine, in the same
		// second: the daemon WITH the axis and the daemon without it. Load moves both
		// together and the ratio stays put. What the ceiling still catches is the thing
		// worth catching, a change of KIND: a network call or an unbounded parse in a
		// guard costs orders of magnitude, not a factor of a few.
		const root = workspaceWith({});
		const withAxis = daemon(root);
		const withoutAxis = daemon(root, { identity: undefined });
		const call = writeOf(root, { "personality.traits.honesty_humility": 0.72 });

		const runs = 200;
		const cost = async (handle: (request: never) => Promise<unknown>): Promise<number> => {
			const timings: number[] = [];
			for (let index = 0; index < runs; index += 1) {
				const started = performance.now();
				await handle(call as never);
				timings.push(performance.now() - started);
			}
			timings.sort((one, other) => one - other);
			// The median rather than a p95: a tail is where a busy machine shows up, and
			// the middle is where the work does.
			return timings[Math.floor(runs / 2)] ?? 0;
		};

		// Interleaved rather than one after the other, so a slow patch of the machine
		// lands on both and not on whichever ran second.
		const baselineFirst = await cost(withoutAxis as never);
		const axisFirst = await cost(withAxis as never);
		const baselineSecond = await cost(withoutAxis as never);
		const axisSecond = await cost(withAxis as never);

		const baseline = Math.max((baselineFirst + baselineSecond) / 2, 0.001);
		const axis = (axisFirst + axisSecond) / 2;

		expect(axis / baseline, `axis ${axis.toFixed(4)}ms vs baseline ${baseline.toFixed(4)}ms`).toBeLessThan(
			500,
		);
	});
});

describe("every gate the daemon builds asks the second axis", () => {
	/**
	 * Structural, and it has to be.
	 *
	 * The sweep in `designed-not-connected` sees that something in this package reaches
	 * `identityGuard`, and this file reaches it, so the sweep would stay green if
	 * `connect` stopped passing the axis tomorrow. What matters is not that the guard
	 * exists somewhere: it is that EVERY handler the daemon serves gets it. There are
	 * two today, the hook's socket and the ACP gate, and a third arriving without the
	 * axis would be a way around the gate rather than a second road to it.
	 *
	 * Read rather than executed because `connect` opens sockets and dials out, and a
	 * test that started a daemon to learn one fact about its construction would be
	 * slow, flaky, and no more truthful than reading the construction.
	 */
	const source = readFileSync(
		join(__dirname, "..", "src", "commands", "connect.ts"),
		"utf-8",
	);

	it("builds at least the two it is supposed to, so this is not a sweep over nothing", () => {
		expect(source.match(/enforcementHandler\(\{/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
	});

	it("passes the axis to every one of them", () => {
		const missing: string[] = [];
		for (const match of source.matchAll(/enforcementHandler\(\{([\s\S]*?)\n\t*\}\)/g)) {
			const body = match[1] ?? "";
			if (!/\bidentity\b/.test(body)) missing.push(body.slice(0, 120));
		}
		expect(missing).toEqual([]);
	});
});

describe("the pieces, where a wrong one would be invisible from outside", () => {
	it("maps each improvement mode onto its own posture", () => {
		// Three modes and three postures, and collapsing any two would make a whole
		// class of persona behave like another with nothing to show for it.
		expect(postureOf("locked")).toBe("locked");
		expect(postureOf("suggesting")).toBe("review");
		expect(postureOf("autonomous")).toBe("autonomous");
	});

	it("finds a path in any argument, whatever the host calls the field", () => {
		const state = join("C:", "work", ".personaxis", "state.json");
		expect(namesState(JSON.stringify({ file_path: state }), "C:\\work", state)).toBe(true);
		expect(namesState(JSON.stringify({ abs_path: state }), "C:\\work", state)).toBe(true);
		expect(namesState(JSON.stringify({ nested: { p: state } }), "C:\\work", state)).toBe(true);
		expect(namesState(JSON.stringify({ file_path: "other.json" }), "C:\\work", state)).toBe(false);
	});

	it("resolves a relative path against the directory the call was made in", () => {
		const root = mkdtempSync(join(tmpdir(), "identity-axis-rel-"));
		made.push(root);
		const state = join(root, ".personaxis", "state.json");
		const relative = join(".personaxis", "state.json");

		expect(namesState(JSON.stringify({ file_path: relative }), root, state)).toBe(true);
	});

	it("reads declared values only from a document that carries them whole", () => {
		expect(declaredValues(JSON.stringify({ content: '{"values":{"a":0.5}}' }))).toEqual({ a: 0.5 });
		// A fragment is not a document, and reading it optimistically is how a guard
		// starts approving things it never saw.
		expect(declaredValues(JSON.stringify({ new_string: '"values": {"a": 0.5}' }))).toBeUndefined();
		expect(declaredValues(JSON.stringify({ content: "not json at all" }))).toBeUndefined();
	});

	it("picks the longest consented directory, so a nested persona governs", () => {
		// The same rule the daemon uses for policy. Two ideas about which root owns a
		// call would show up as one road enforcing a persona the other never heard of.
		const scope = [join("C:", "work"), join("C:", "work", "inner")];
		expect(rootFor(join("C:", "work", "inner", "src"), scope)).toBe(join("C:", "work", "inner"));
		expect(rootFor(join("C:", "work", "src"), scope)).toBe(join("C:", "work"));
		expect(rootFor(join("C:", "elsewhere"), scope)).toBeNull();
	});
});
