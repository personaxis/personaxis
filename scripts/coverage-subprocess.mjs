// Which source files nothing executes, counting the child processes too.
//
// Sixteen suites drive the CLI the way a person does, by spawning
// `node dist/index.js` and asserting on real output. V8 coverage in the parent
// sees none of that, so every command file reports 0% while being exercised end to
// end, and the package's line coverage reads 40.6% when the truth is far higher.
// That number was in `vitest.floor.ts` with a paragraph explaining it could not be
// trusted, which is a poor substitute for measuring it.
//
// `NODE_V8_COVERAGE` is inherited by child processes, so each spawn writes its own
// profile, and `dist/x.js` maps back to `src/x.ts` one to one because the build is
// plain `tsc`. Combining the two answers the question the in-process number could
// not: which files does NOTHING run.
//
// Measured 2026-08-30: 145 source files, 137 executed by a child process, 8 not.
// Two of those eight are type declarations with no runtime at all.
//
// Usage:
//   node scripts/coverage-subprocess.mjs          check against the ceiling
//   node scripts/coverage-subprocess.mjs --list   print what is unexecuted

import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "packages", "cli");

/**
 * Files with no runtime, so no profile can ever show them executed.
 *
 * A file of `interface` and `type` compiles to nothing, and counting it as dead
 * would be counting the type system as dead. Listed rather than pattern-matched on
 * the name, because `types.ts` is a convention and conventions get broken.
 */
const NO_RUNTIME = new Set(["linter/types.ts", "repl/types.ts"]);

/**
 * Code nothing runs, with what would change that.
 *
 * The ceiling is the length of this list. It may go down. A file arriving here is
 * a file shipped to users that no test has ever executed once.
 */
const UNEXECUTED = {
	"host/engine-host.ts": "the engine-as-host path; phase 11 either uses it or deletes it",
	"scan-bin.ts": "a scanning entry point nothing invokes; find its caller or drop it",
	"statusline.ts": "the status line for a host that renders one; unreachable from any test",
	"targets/cursor.ts": "a compile target for Cursor, never exercised by the target tests",
	"targets/soul-md.ts": "a compile target kept from an older format",
	"workspace/world.ts": "the world a daemon runs in, waiting on the hosted phases (W3, W5, W7)",
};
const CEILING = Object.keys(UNEXECUTED).length;

function sources(dir, base = dir, out = []) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) sources(path, base, out);
		else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
			out.push(path.slice(base.length + 1).replaceAll("\\", "/"));
		}
	}
	return out;
}

const profiles = mkdtempSync(join(tmpdir(), "personaxis-cov-"));
try {
	// One string rather than args plus `shell`, which node deprecates because
	// nothing escapes them. Every part here is a literal.
	execSync("npx vitest run --reporter=dot", {
		cwd: CLI,
		env: { ...process.env, NODE_V8_COVERAGE: profiles },
		stdio: "ignore",
	});
} catch {
	// A failing suite is still a valid set of profiles for this question, and the
	// suite reports its own failures. Nothing to add here.
}

const executed = new Set();
for (const file of readdirSync(profiles)) {
	let profile;
	try {
		profile = JSON.parse(readFileSync(join(profiles, file), "utf8"));
	} catch {
		continue;
	}
	for (const script of profile.result ?? []) {
		const url = String(script.url ?? "");
		if (!url.includes("/packages/cli/dist/")) continue;
		// A script V8 loaded but never entered has every count at zero.
		if (!(script.functions ?? []).some((fn) => (fn.ranges ?? []).some((r) => r.count > 0))) continue;
		const rel = url.split("/packages/cli/dist/")[1];
		if (rel) executed.add(rel.replace(/\.js$/, ".ts"));
	}
}
rmSync(profiles, { recursive: true, force: true });

const all = sources(join(CLI, "src")).filter((file) => !file.startsWith("generated/"));
const dead = all.filter((file) => !executed.has(file) && !NO_RUNTIME.has(file));

if (executed.size === 0) {
	console.error("subprocess coverage: no profile named a dist file. The sweep measured nothing.");
	process.exit(1);
}

if (process.argv.includes("--list")) {
	console.log(`source files: ${all.length}`);
	console.log(`executed:     ${all.length - dead.length - NO_RUNTIME.size}`);
	console.log(`type only:    ${NO_RUNTIME.size}`);
	console.log(`unexecuted:   ${dead.length}`);
	for (const file of dead.sort()) console.log(`  ${file}  ${UNEXECUTED[file] ?? "NEW, no reason on record"}`);
	process.exit(0);
}

const unexplained = dead.filter((file) => !(file in UNEXECUTED));
const fixed = Object.keys(UNEXECUTED).filter((file) => !dead.includes(file));

if (unexplained.length > 0) {
	console.error(`subprocess coverage: ${unexplained.length} file(s) nothing executes, and no reason on record:`);
	for (const file of unexplained) console.error(`  ${file}`);
	process.exit(1);
}
if (fixed.length > 0) {
	console.error(`subprocess coverage: ${fixed.length} entr(ies) outlived their reason. Something runs these now:`);
	for (const file of fixed) console.error(`  ${file}`);
	process.exit(1);
}
if (dead.length > CEILING) {
	console.error(`subprocess coverage: ${dead.length} unexecuted files, ceiling ${CEILING}.`);
	process.exit(1);
}

console.log(
	`subprocess coverage: ${all.length} files, ${all.length - dead.length - NO_RUNTIME.size} executed, ${dead.length} not (ceiling ${CEILING}).`,
);
