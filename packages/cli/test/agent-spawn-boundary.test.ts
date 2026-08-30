// Where an agent process may be started, and nowhere else.
//
// The daemon does not run a persona today. It shells out to somebody else's agent:
// `host-adapter.ts` declares `bin: "claude"` and `bin: "codex"`, `host-session.ts`
// does the spawning, and `job-runner.ts` reaches for a `HostSession`. That is the
// single most consequential fact about the current runtime, because it is why a
// job assigned to a machine is executed by a program we do not control and cannot
// interrupt: the launch uses `stdio: ["ignore", "pipe", "pipe"]`, so there is no
// channel back into a session that has already started.
//
// Phase 11 replaces that with a provider behind the seam `LoopProvider` already
// defines. The point of this file is what happens in between and after.
//
// ## What it pins, and why now rather than after phase 11
//
// One place declares which binaries are agents, and one place starts them. Not
// because spawning is wrong, but because a second place would be a second thing to
// find and change when the provider lands, and a second thing to miss. The audit
// that started this plan found exactly that shape elsewhere: a mechanism that grew
// a second implementation nobody remembered.
//
// Written before phase 11 rather than after because the value is in the gap. A test
// added afterwards proves a property of code somebody just wrote. This one has to
// survive the rewrite, and if it starts failing during phase 11 the failure is the
// interesting part: it means the provider did not replace the spawn, it joined it.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/** The agent binaries this repository knows how to shell out to. */
const AGENT_BINARIES = ["claude", "codex", "openclaw", "hermes"] as const;

/**
 * The one file allowed to name an agent binary, and the one allowed to start it.
 *
 * Relative to `src`. Two files, two jobs: the adapter says what a host is, the
 * session runs one.
 */
const MAY_DECLARE = "workspace/host-adapter.ts";
const MAY_SPAWN = "workspace/host-session.ts";

/**
 * Files in the daemon allowed to reach for `node:child_process`, and what for.
 *
 * Two, and the difference between them is the whole rule. `host-session` RUNS an
 * agent: it hands over a prompt and a working directory and waits. `machine` only
 * ASKS whether one is installed, by running `--version` and reading the answer,
 * which is how the daemon reports what a machine can host. A probe is not a run,
 * and collapsing them would either ban the probe or bless the run.
 */
const MAY_USE_CHILD_PROCESS: Record<string, string> = {
	"workspace/host-session.ts": "runs the agent: prompt in, stream out",
	"workspace/machine.ts": "probes `--version` to report which agents this machine has",
};

function sources(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) sources(path, out);
		else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(path);
	}
	return out;
}

/** Comments blanked, so a comment about `bin: "claude"` is not a file that runs it. */
function code(file: string): string {
	return readFileSync(file, "utf8")
		.replaceAll(/\/\*[\s\S]*?\*\//g, "")
		.replaceAll(/\/\/[^\n]*/g, "");
}

function relative(file: string): string {
	return file.slice(SRC.length + 1).replaceAll("\\", "/");
}

describe("an agent process starts in one place", () => {
	const files = sources(SRC);

	it("reads a real amount of source, so a clean result means something", () => {
		expect(files.length).toBeGreaterThan(100);
	});

	it.each(AGENT_BINARIES)("only host-adapter declares `bin: %s`", (binary) => {
		const declaring = files
			.filter((file) => new RegExp(`bin:\\s*["']${binary}["']`).test(code(file)))
			.map(relative);
		expect(
			declaring.filter((file) => file !== MAY_DECLARE),
			`only ${MAY_DECLARE} may say which binary is an agent`,
		).toEqual([]);
	});

	it("still finds the declarations it is guarding, so the sweep is not vacuous", () => {
		// If the adapter is refactored and this pattern stops matching, every
		// assertion above passes over nothing and the boundary quietly stops
		// existing. Two binaries are declared today.
		const adapter = code(join(SRC, MAY_DECLARE));
		const found = AGENT_BINARIES.filter((binary) =>
			new RegExp(`bin:\\s*["']${binary}["']`).test(adapter),
		);
		expect(found.length).toBeGreaterThan(0);
	});

	it("the job runner does not spawn anything itself", () => {
		// It composes a session; it does not start a process. When the provider
		// lands, this is the file that must not have grown a second path.
		const runner = code(join(SRC, "workspace", "job-runner.ts"));
		expect(runner).not.toMatch(/\bspawn\s*\(/);
		expect(runner).not.toMatch(/child_process/);
	});

	it("only host-session spawns a process inside workspace/", () => {
		// Narrowed to the daemon's own directory on purpose. The REPL opens editors
		// and re-launches this same binary, which are not agents and not what this
		// boundary is about.
		// Matched on the IMPORT rather than on a call. `host-session` spawns through
		// an injectable `spawnFn`, so it never writes `spawn(`, and a call-site sweep
		// found nothing at all: the shape of a rule that passes because it looked in
		// the wrong place. Reaching for `node:child_process` cannot be hidden behind
		// a parameter name.
		const importing = files
			.filter((file) => relative(file).startsWith("workspace/"))
			.filter((file) => /from\s*["']node:child_process["']/.test(code(file)))
			.map(relative);
		expect(
			importing.filter((file) => !(file in MAY_USE_CHILD_PROCESS)),
			"a new file in the daemon starting processes, outside the two that say why",
		).toEqual([]);
		// And the two that are allowed are still both there, so the list cannot
		// outlive what it excused.
		expect(importing.sort()).toEqual(Object.keys(MAY_USE_CHILD_PROCESS).sort());
	});

	it("host-session is still the one reaching for child_process", () => {
		// Guards the sweep above: if that import moves or is renamed, the list goes
		// empty and the boundary passes over nothing.
		expect(code(join(SRC, MAY_SPAWN))).toMatch(/from\s*["']node:child_process["']/);
	});
});
