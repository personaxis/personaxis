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

/**
 * Every source under a root, tests included: a test in another package is a real
 * consumer.
 *
 * **`.tsx` counts, and leaving it out was a hole on the dangerous side.** Measured on
 * 2026-09-03: 22 source files and 12 test files across `tui` and `cli` are `.tsx`,
 * and the sweep could not see any of them. Invisible exports are a small problem, a
 * package looking cleaner than it is. Invisible CONSUMERS are the bad one: an export
 * reached only from a screen would come back an orphan, and the count would carry
 * false names that nobody can act on, which is how a ratchet becomes a number people
 * stop believing.
 */
function sources(root: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(root)) {
		const path = join(root, entry);
		if (statSync(path).isDirectory()) {
			found.push(...sources(path));
		} else if ((entry.endsWith(".ts") || entry.endsWith(".tsx")) && !entry.endsWith(".d.ts")) {
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

/**
 * The packages this rule can speak about, and why that is not all of them.
 *
 * A name counts as used when something OUTSIDE its own module reaches it, and the
 * strongest version of that is another package, because importing across a package
 * boundary is a dependency. That test only means something for a package something
 * else depends on. Measured on 2026-09-03:
 *
 *     core      <- cli, evals, mcp, protocol, sdk, tui
 *     protocol  <- cli, tui
 *     spec      <- cli, evals
 *     sdk       <- cli, mcp
 *     tui       <- cli
 *     mcp       <- nobody in this repository
 *     evals     <- nobody
 *     cli       <- nobody: it is the binary
 *
 * So `mcp`, `evals` and `cli` are left out, and the reason is a limit rather than an
 * oversight worth writing down: their consumers are outside this tree, so every
 * export would come back an orphan and the number would be noise. A ratchet that
 * counts noise is a ratchet nobody can lower, and one nobody can lower is one that
 * stops meaning anything.
 *
 * ## Why one number per package and not one number
 *
 * A single total would let a package go quietly wrong while another improved by the
 * same amount, which is the failure the ratchet exists to prevent, one level up.
 *
 * `protocol` starts at whatever the ACP bridge leaves behind, and that is correct
 * rather than unfortunate: `A1` built the provider and `A2` wires it into the
 * daemon, so between the two commits it is designed and not connected, and this is
 * the thing that says so out loud.
 */
const WATCHED: { readonly pkg: string; readonly departure: number }[] = [
	{ pkg: "core", departure: 176 },
	{ pkg: "protocol", departure: 15 },
	{ pkg: "tui", departure: 34 },
];

/**
 * Watched by nothing, each with the measured reason.
 *
 * `spec` and `sdk` were on the list above for one run and came back zero orphans,
 * which looked like two clean packages and was **nothing having been read**. Their
 * entire source is `index.ts`, plus generated code in `spec`, and the sweep skips a
 * barrel on purpose: a barrel promises, it does not consume. A rule reporting zero
 * because it looked at no files is the same failure as an empty sweep passing, and
 * it is worse than a red one because it reads as good news.
 *
 * `mcp`, `evals` and `cli` are out for the other reason: nothing in this repository
 * depends on them, so every export would come back an orphan and the number would be
 * noise. `cli` is the binary.
 *
 * The test below is what stops this list growing by accident: a watched package that
 * stops having files to sweep goes red instead of quietly reporting zero.
 */
const NOT_WATCHED = [
	{ pkg: "spec", because: "its whole source is a barrel and generated code" },
	{ pkg: "sdk", because: "its whole source is a barrel" },
	{ pkg: "mcp", because: "nothing in this repository depends on it" },
	{ pkg: "evals", because: "nothing depends on it" },
	{ pkg: "cli", because: "it is the binary: nothing depends on it" },
];

/** Names exempt in a given package, with the task that connects each. */
const WAITING_BY_PACKAGE: Record<string, typeof WAITING> = { core: WAITING };

/** The package's own sources. Generated files are nobody's design. */
function filesOf(pkg: string): string[] {
	return sources(join(PACKAGES, pkg, "src")).filter((path) => !path.includes(`${"generated"}`));
}

/**
 * Everything outside the package, source and tests both.
 *
 * **A package's own tests are not here, and that is the whole measurement.** Every
 * one of the ten modules the audit found has passing tests; that is what made them
 * look finished. A test proves the code runs, which was never in question. What is
 * in question is whether anything reaches it, and a test sitting in the same package
 * cannot answer that.
 */
function consumersOf(pkg: string): string[] {
	return readdirSync(PACKAGES)
		.filter((name) => name !== pkg)
		.flatMap((name) => [join(PACKAGES, name, "src"), join(PACKAGES, name, "test")])
		.filter((path) => {
			try {
				return statSync(path).isDirectory();
			} catch {
				return false;
			}
		})
		.flatMap((root) => sources(root));
}

describe.each(WATCHED)("$pkg's exports reach something", ({ pkg, departure }) => {
	const own = filesOf(pkg);
	const waiting = WAITING_BY_PACKAGE[pkg] ?? [];
	const exempt = new Set(waiting.map((entry) => entry.name));

	// Built once: this is a whole-tree sweep and the packages are not small.
	const imports = new Map<string, Set<string>>();
	for (const file of [...own, ...consumersOf(pkg)]) {
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
		const stem = from.replace(/\.tsx?$/, "");
		for (const [file, names] of imports) {
			if (file === from) continue;
			const isOwnTest = file.includes(`${"test"}`) && file.includes(`${stem.split(/[\\/]/).pop()}`);
			if (isOwnTest) continue;
			if (names.has(name)) return true;
		}
		return false;
	}

	/**
	 * What is actually examined: everything but the barrels.
	 *
	 * Split out from `own` because the guard below has to count the same thing the
	 * loop does. It did not, for one run: it counted files READ, `sdk` had one file
	 * and it was `index.ts`, and a package with nothing examined reported a clean
	 * zero and passed the guard meant to catch exactly that. Measuring the wrong
	 * quantity is the commonest way a gate reports on itself instead of its subject.
	 */
	const swept = own.filter((file) => !file.endsWith("index.ts") && !file.endsWith("index.tsx"));

	const orphans: { name: string; module: string }[] = [];
	for (const file of swept) {
		for (const name of exportsOf(readFileSync(file, "utf8"))) {
			if (exempt.has(name)) continue;
			if (!isUsed(name, file)) {
				orphans.push({
					name,
					module: relative(join(PACKAGES, pkg, "src"), file).replaceAll("\\", "/"),
				});
			}
		}
	}

	/**
	 * The line of departure, and it only moves one way.
	 *
	 * Writing a reason for each of core's 176 would mean inventing 176 reasons, and an
	 * invented reason is worse than a number: it reads as a decision somebody made. So
	 * the ones that matter are named above with the task that connects them, and the
	 * rest are a count that may go down and never up.
	 *
	 * That is the same shape as the design drift ratchet in the other repository, for
	 * the same reason: the rule is right, the existing violations are too many to fix
	 * in one pass, and letting them grow is what actually kills a rule.
	 *
	 * **Every one of these numbers came from this gate, not from an author.** Each was
	 * set by dropping it to zero and reading the list back. The 177 that stood here
	 * before was one above the real count, which is a ceiling above today's value, and
	 * a ceiling above today's value is permission.
	 */
	it("read something, so a pass is not an empty sweep", () => {
		// The guard that catches the failure `spec` and `sdk` walked into: zero orphans
		// out of zero files read is not a clean package, it is a rule that was never
		// applied, and it is indistinguishable from success unless something asks.
		expect(swept.length, `${pkg}: nothing to sweep, so its zero means nothing`).toBeGreaterThan(0);
		expect(imports.size, `${pkg}: no consumers read`).toBeGreaterThan(own.length);
	});

	it("has no more unreachable exports than the day this was written", () => {
		expect(
			orphans.length,
			orphans.length > departure
				? `${orphans.length - departure} more unreachable export(s) in ${pkg} than the ${departure} this started at. ` +
					`Diff this list against the previous run to see which: ` +
					orphans.map((orphan) => `${orphan.module}:${orphan.name}`).join(" ")
				: "",
		).toBeLessThanOrEqual(departure);
	});

	it("keeps the ratchet honest: the number is the count, not a comfortable round figure", () => {
		// A ratchet nobody lowers is a ratchet that stopped meaning anything. When this
		// goes red because the real count dropped, lower the departure in the same commit
		// that did the work.
		expect(orphans.length, `${pkg}: the count fell; lower its departure to lock the gain in`).toBe(
			departure,
		);
	});

	it("keeps every exemption honest: each says what would make it live", () => {
		// An empty list is a real state, not a skipped test: most packages have no
		// exemptions, and `it.each([])` over one would be an error rather than a pass.
		const silent = waiting.filter((entry) => !entry.until);
		expect(silent.map((entry) => entry.name)).toEqual([]);
	});

	it("has no exemption for something that is already connected", () => {
		// The other direction, and the one that rots. An entry that stayed after its
		// phase landed is a hole in the sweep that nobody can see, because a passing
		// test looks the same either way.
		const connected = waiting.filter((entry) => {
			const defining = own.find((file) =>
				exportsOf(readFileSync(file, "utf8")).includes(entry.name),
			);
			return defining !== undefined && isUsed(entry.name, defining);
		});
		expect(connected.map((entry) => entry.name)).toEqual([]);
	});
});

describe("the packages this rule cannot speak about", () => {
	it("each says why, because a silent omission is a hole nobody can see", () => {
		for (const entry of NOT_WATCHED) {
			expect(entry.because, `${entry.pkg} is unwatched with no reason`).toBeTruthy();
		}
	});

	it("names every package, so a new one cannot arrive unwatched and unmentioned", () => {
		// The failure this catches: somebody adds `packages/browser`, it is neither
		// watched nor excused, and the sweep stays green while a whole package goes
		// unlooked-at. A new package has to be a decision, not a default.
		const known = new Set([...WATCHED.map((w) => w.pkg), ...NOT_WATCHED.map((n) => n.pkg)]);
		const onDisk = readdirSync(PACKAGES).filter((name) => {
			try {
				return statSync(join(PACKAGES, name, "package.json")).isFile();
			} catch {
				return false;
			}
		});
		expect(onDisk.filter((name) => !known.has(name))).toEqual([]);
	});
});
