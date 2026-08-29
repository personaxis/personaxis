/**
 * Designed, and never connected.
 *
 * The engine's version of the sweep the SaaS already runs, and it exists because the
 * audit of 2026-08-28 measured the same failure here and worse: **1.199 lines across
 * ten modules, written, commented, tested, and called by nothing**. Not stray helpers.
 * `gate/identity.ts` is the second axis of the two-axis gate, the one thing this
 * product claims nobody else can do, and it appears in exactly two files, both tests.
 * `tools/mcp-adapter.ts` is how a third-party MCP server's tools would reach the loop,
 * and its only caller is its own test.
 *
 * None of that is a code-quality complaint. A module that is finished, correct and
 * unreachable reads as done from inside its own file, passes type-check, passes its
 * tests, and survives review, because review reads the module and not the absence of
 * its caller. The only thing that catches it is a sweep.
 *
 * ## How a name counts as used
 *
 * Two signals, because the engine is consumed two ways and either one alone lies.
 *
 * A bare-identifier search lies loudly. `security/mcp-provenance.ts` exports
 * `describe`, so it looks alive in every test file that ever wrote one, and
 * `blackboard.ts` exports `orchestrate`, which is also the name of a CLI command.
 * That is the mistake the by-hand audit made in both directions.
 *
 * An import-only search lies quietly, which is worse. The barrel exports NAMESPACES:
 * `export * as gate`, `export * as run`, `export * as record`. So the daemon reaches
 * the gate as `gate.runGuards(guards, call)` and the REPL asks for a turn as
 * `run.runnerFor(...)`, and neither name appears in any import statement anywhere.
 * Counting imports alone reported 223 orphans across 96 modules, which is not a
 * finding, it is a broken instrument.
 *
 * So a name is used when another file imports it by name, OR uses it qualified as
 * `.name`. The second catches every namespace consumer. It can over-count, when an
 * unrelated object happens to have a property of the same name, and that direction is
 * the safe one: a false alive misses an orphan, a false orphan blocks the build on a
 * lie.
 *
 * ## What the exemption list is for
 *
 * Every entry says **what would make it live**, and names the task that does it. An
 * exemption without that is the same silence this exists to break, one indirection
 * further away. When a phase lands, its entries come off and the sweep goes red if
 * the wiring did not actually happen, which is the point: a plan that says a thing is
 * connected and a repository where it is not should not be able to disagree quietly.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES = join(HERE, "..", "..");
const CORE_SRC = join(PACKAGES, "core", "src");

/**
 * Waiting on something named, rather than forgotten.
 *
 * The ten the audit found, each with the task that closes it. These are not debt to
 * delete: between them they are most of what the next phases exist to wire up.
 */
const WAITING: { readonly name: string; readonly until: string }[] = [
	// The second axis of the gate. `enforcement-service.ts` says in a comment that the
	// identity axis arrives through `deps.guards`, and `connect.ts`, the only
	// production construction, passes no guards. So the differentiator runs in tests.
	{ name: "identityGuard", until: "E1 mounts it in the daemon" },
	{ name: "examine", until: "E1 mounts the identity axis" },
	{ name: "postureFor", until: "E1 mounts the identity axis" },
	{ name: "capabilityGuard", until: "E2 mounts it as a guard of the waterfall" },
	{ name: "requirePolicy", until: "E2 mounts it as a guard of the waterfall" },

	// Third-party MCP tools. We are an MCP server and not a client, which is why the
	// engine has six tools and the reference has 129.
	{ name: "mcpToolToSpec", until: "E3 makes the engine an MCP client" },

	// Effort levels and what a destination declares it accepts.
	{ name: "resolveEffort", until: "E8 mounts the model seam" },
	{ name: "forDestination", until: "E8 mounts the model seam" },
	{ name: "mayReplay", until: "E8 mounts the model seam" },
	{ name: "EFFORT_LADDER", until: "E8 mounts the model seam" },

	// Comparing two runs of the same persona, and reading why one decision led to the
	// next.
	{ name: "compareRuns", until: "E9 mounts regression" },
	{ name: "describeComparison", until: "E9 mounts regression" },
	{ name: "SCORE_DROP_THRESHOLD", until: "E9 mounts regression" },
	{ name: "BEHAVIORAL_FLIP_THRESHOLD", until: "E9 mounts regression" },
	{ name: "buildTrace", until: "E9 mounts the causal trace" },
	{ name: "describeTrace", until: "E9 mounts the causal trace" },
	{ name: "traceIsInteresting", until: "E9 mounts the causal trace" },

	// The loop breaker as a guard, and layered resolution with a policy tier.
	{ name: "breakerGuard", until: "E10 mounts it" },
	{ name: "nudgeFor", until: "E10 mounts it" },
	{ name: "resolveLayered", until: "E10 mounts config layers" },
	{ name: "resolvePolicyTier", until: "E10 mounts config layers" },
	{ name: "CONFIG_LAYERS", until: "E10 mounts config layers" },

	// Compaction that carries its own author and its measured drift. Waiting on E6,
	// which is where compaction moves to explicit cut points.
	{ name: "compactionAuthor", until: "E6 compacts at explicit cut points" },
	{ name: "compactionEntry", until: "E6 compacts at explicit cut points" },
	{ name: "driftAcross", until: "E6 compacts at explicit cut points" },

	// The session index. E11 decides: mount it, or delete it with the reason written.
	{ name: "readSessionIndex", until: "E11 decides whether the session index lives" },
	{ name: "rebuildSessionIndex", until: "E11 decides whether the session index lives" },
	{ name: "SessionWriter", until: "E11 decides whether the session index lives" },
];

const EXEMPT = new Set(WAITING.map((entry) => entry.name));

/** Every `.ts` under a root, tests included: a test in another package is a real consumer. */
function sources(root: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(root)) {
		const path = join(root, entry);
		if (statSync(path).isDirectory()) {
			found.push(...sources(path));
		} else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
			found.push(path);
		}
	}
	return found;
}

/** Comments hold the names of things on purpose; a mention there is not a call. */
function code(source: string): string {
	return source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/\/\/[^\n]*/g, "");
}

/** Exported values. Types are excluded: an unused type is not an unreachable subsystem. */
function exportsOf(source: string): string[] {
	const names: string[] = [];
	const body = code(source);
	for (const match of body.matchAll(/^export\s+(?:async\s+)?(?:function|class|const|let)\s+([A-Za-z0-9_$]+)/gm)) {
		names.push(match[1]!);
	}
	return names;
}

/** Every name a file reaches for: by import, and by `namespace.name`. */
function reaches(source: string): Set<string> {
	const names = new Set<string>();
	const body = code(source);
	for (const match of body.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from/g)) {
		for (const part of match[1]!.split(",")) {
			// `a as b` binds b and uses a; the name that counts is the one on the left.
			const name = part.trim().split(/\s+as\s+/)[0]?.replace(/^type\s+/, "").trim();
			if (name) names.add(name);
		}
	}
	// `gate.runGuards`, `run.runnerFor`, `record.UNNAMED_OPERATOR`: the barrel's
	// namespaces, which no import statement mentions.
	for (const match of body.matchAll(/\.\s*([A-Za-z0-9_$]+)/g)) names.add(match[1]!);
	return names;
}

const CORE_FILES = sources(CORE_SRC).filter((path) => !path.includes(`${"generated"}`));

/**
 * Everything outside core, source and tests both.
 *
 * **Core's own tests are not here, and that is the whole measurement.** Every one of
 * the ten modules the audit found has passing tests; that is what made them look
 * finished. A test proves the code runs, which was never in question. What is in
 * question is whether anything reaches it, and a test sitting in the same package
 * cannot answer that. A test in another package can, because importing across a
 * package boundary is a dependency.
 */
const CONSUMERS = readdirSync(PACKAGES)
	.filter((name) => name !== "core")
	.flatMap((name) => [join(PACKAGES, name, "src"), join(PACKAGES, name, "test")])
	.filter((path) => {
		try {
			return statSync(path).isDirectory();
		} catch {
			return false;
		}
	})
	.flatMap((root) => sources(root));

describe("the engine's exports reach something", () => {
	// Built once: this is a whole-tree sweep and the packages are not small.
	const imports = new Map<string, Set<string>>();
	for (const file of [...CORE_FILES, ...CONSUMERS]) {
		imports.set(file, reaches(readFileSync(file, "utf8")));
	}

	/**
	 * A name is used when a file that is not its own module imports it.
	 *
	 * A module's own test does not count. It proves the code runs, which was never in
	 * doubt: every one of the ten the audit found has passing tests. It does not prove
	 * anything reaches it.
	 */
	function isUsed(name: string, from: string): boolean {
		const own = from.replace(/\.ts$/, "");
		for (const [file, names] of imports) {
			if (file === from) continue;
			const isOwnTest = file.includes(`${"test"}`) && file.includes(`${own.split(/[\\/]/).pop()}`);
			if (isOwnTest) continue;
			if (names.has(name)) return true;
		}
		return false;
	}

	const orphans: { name: string; module: string }[] = [];
	for (const file of CORE_FILES) {
		if (file.endsWith("index.ts")) continue; // a barrel promises, it does not consume
		for (const name of exportsOf(readFileSync(file, "utf8"))) {
			if (EXEMPT.has(name)) continue;
			if (!isUsed(name, file)) {
				orphans.push({ name, module: relative(CORE_SRC, file).replaceAll("\\", "/") });
			}
		}
	}

	/**
	 * The line of departure, and it only moves one way.
	 *
	 * 177 exports in the engine reach nothing. Writing a reason for each would mean
	 * inventing 177 reasons, and an invented reason is worse than a number: it reads as
	 * a decision somebody made. So the ones that matter are named above with the task
	 * that connects them, and the rest are a count that may go down and never up.
	 *
	 * That is the same shape as the design drift ratchet in the other repository, for
	 * the same reason: the rule is right, the existing violations are too many to fix
	 * in one pass, and letting them grow is what actually kills a rule.
	 *
	 * Most of these are not subsystems. They are a helper exported when it was written
	 * next to its one caller, and `export` is the default gesture. That is cheap to
	 * fix and worth nothing to hurry.
	 */
	const DEPARTURE = 177;

	it("has no more unreachable exports than the day this was written", () => {
		// The message says the count and where to look, and does NOT claim to name the
		// new one. It cannot: without a stored baseline list it only knows the total
		// moved. Printing the first five and calling them new would be a failure
		// message that sends somebody to the wrong file, which is worse than a bare
		// number because it looks like help.
		expect(
			orphans.length,
			orphans.length > DEPARTURE
				? `${orphans.length - DEPARTURE} more unreachable export(s) than the ${DEPARTURE} this started at. ` +
					`Diff this list against the previous run to see which: ` +
					orphans.map((orphan) => `${orphan.module}:${orphan.name}`).join(" ")
				: "",
		).toBeLessThanOrEqual(DEPARTURE);
	});

	it("keeps the ratchet honest: the number is the count, not a comfortable round figure", () => {
		// A ratchet nobody lowers is a ratchet that stopped meaning anything. When this
		// goes red because the real count dropped, lower DEPARTURE in the same commit
		// that did the work.
		expect(orphans.length, "the count fell; lower DEPARTURE to lock the gain in").toBe(DEPARTURE);
	});

	it("keeps every exemption honest: each says what would make it live", () => {
		for (const entry of WAITING) {
			expect(entry.until, `${entry.name} is exempt with no reason`).toBeTruthy();
		}
	});

	it("has no exemption for something that is already connected", () => {
		// The other direction, and the one that rots. An entry that stayed after its
		// phase landed is a hole in the sweep that nobody can see, because a passing
		// test looks the same either way.
		const connected = WAITING.filter((entry) => {
			const defining = CORE_FILES.find((file) => exportsOf(readFileSync(file, "utf8")).includes(entry.name));
			return defining !== undefined && isUsed(entry.name, defining);
		});
		expect(connected.map((entry) => entry.name)).toEqual([]);
	});
});
