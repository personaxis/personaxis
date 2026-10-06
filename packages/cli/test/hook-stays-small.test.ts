/**
 * What the hook loads, which is the thing the latency budget was really watching.
 *
 * `workspace-hook-contract` has a wall-clock test whose header says plainly what it
 * exists to catch: "the change that starts importing the engine into this path. That
 * would show up as hundreds of milliseconds ON TOP of starting Node." It is the right
 * thing to watch and the wrong instrument to watch it with, and on 2026-09-03 that
 * stopped being an opinion.
 *
 * Measured, three conditions, five interleaved pairs each:
 *
 *                       floor   hook, no server   hook, with server
 *     alone               78         200                205
 *     under `pnpm -r`    190         790                896
 *
 * Two things fall out. The socket round trip is 5 ms alone and 106 ms under load, so
 * the test harness's own server is not what was blowing the budget. And loading the
 * hook's module graph degrades **five times** under load while starting bare Node
 * degrades 2.4, so neither the difference (122 ms against 600) nor the ratio (2.6
 * against 4.2) is stable. A wall clock cannot separate "somebody imported the engine"
 * from "eight vitest instances are running" on that evidence, at any budget.
 *
 * What CAN separate them is the import graph, which does not care how busy the
 * machine is. So the sensitivity lives here, and the timing test keeps a loose
 * ceiling for catastrophe. The alternative was raising a number until it went green,
 * which is how a gate becomes scenery.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK_BIN = resolve(join(HERE, "..", "dist", "hook-bin.js"));

/** Everything the hook reaches, following relative imports from its entry point. */
function graphOf(entry: string): { files: Set<string>; externals: Set<string> } {
	const files = new Set<string>();
	const externals = new Set<string>();

	const walk = (file: string): void => {
		if (files.has(file)) return;
		files.add(file);

		let source: string;
		try {
			source = readFileSync(file, "utf8");
		} catch {
			// A path that does not resolve is not silently fine, but it is also not
			// this test's business: the build would have failed. Recorded by its
			// absence from the count, which is what the ratchet reads.
			return;
		}

		for (const match of source.matchAll(/from\s*["']([^"']+)["']/g)) {
			const spec = match[1]!;
			if (spec.startsWith(".")) {
				const path = resolve(dirname(file), spec);
				walk(path.endsWith(".js") ? path : `${path}.js`);
				continue;
			}
			// The package, not the subpath: `@personaxis/protocol/workspace` is the
			// same dependency as `@personaxis/protocol`.
			externals.add(spec.split("/").slice(0, spec.startsWith("@") ? 2 : 1).join("/"));
		}
	};

	walk(entry);
	return { files, externals };
}

describe("the hook is its own small binary, and stays one", () => {
	it("reads the built hook, so a pass is not an empty walk", () => {
		// The failure this guards: `dist` not built, the walk finding one unreadable
		// file, and every assertion below passing over nothing.
		const source = readFileSync(HOOK_BIN, "utf8");
		expect(source.length).toBeGreaterThan(100);
		expect(source).toContain("import");
	});

	it("does not import the engine", () => {
		// The whole point, and the thing the wall clock was a proxy for. The hook runs
		// before every tool call a host makes. Pulling the engine into it would put
		// hundreds of milliseconds on each one, and the person who did it would see
		// nothing wrong: the code would work.
		const { externals } = graphOf(HOOK_BIN);
		expect([...externals].filter((name) => name === "@personaxis/core")).toEqual([]);
	});

	it("depends on what it needs and nothing else", () => {
		// A literal list rather than a count, because which dependency arrived is the
		// interesting half. `@personaxis/protocol` is here for the socket framing.
		const { externals } = graphOf(HOOK_BIN);
		const packages = [...externals].filter((name) => !name.startsWith("node:")).sort();
		expect(packages).toEqual(["@personaxis/protocol"]);
	});

	it("reaches no more files than the day this was written", () => {
		// Three, and it only moves down. Not a style rule: every file here is read
		// from disk on every tool call, and disk is the part that degrades fivefold
		// when the machine is busy, which is precisely what made the latency version
		// of this test unusable.
		const { files } = graphOf(HOOK_BIN);
		expect(
			files.size,
			`the hook now reaches ${files.size} files: ${[...files].map((f) => f.split(/[\\/]/).pop()).join(", ")}`,
		).toBeLessThanOrEqual(3);
	});

	it("keeps the ratchet honest: the number is the count", () => {
		// When this goes red because the count dropped, lower the number above in the
		// same commit that did the work.
		expect(graphOf(HOOK_BIN).files.size).toBe(3);
	});
});
