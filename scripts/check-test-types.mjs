#!/usr/bin/env node
/**
 * Type-check the TESTS, which nothing else does.
 *
 * Every package's tsconfig has `"include": ["src"]`, so `tsc --noEmit` never looked at
 * a single test file. Vitest transpiles without checking. The result is that roughly
 * 2,600 tests were outside the type checker entirely, and a test could claim a type it
 * did not have with nothing to say otherwise.
 *
 * That is not hypothetical: it was found by writing one. A helper declared
 * `ExecutablePolicy` while returning the shape of a `CompiledPolicy`, and then handed
 * it to the parameter that takes a sandbox `Policy`. Three types, one object, no
 * complaint. The tests still passed, because they measured token accounting and a
 * broken policy does not change that. A test that passes while lying about its types
 * is a test nobody can read.
 *
 * WHY A RATCHET AND NOT A GATE
 *
 * There are already errors in here, and most predate this script. Failing the build on
 * all of them would either stop the build for days or, far more likely, get the script
 * deleted. So the number is the ceiling, it may only come down, and a new test cannot
 * add to it. Same shape as the designed-not-connected ratchet, for the same reason.
 *
 *   node scripts/check-test-types.mjs          check against the ceiling
 *   node scripts/check-test-types.mjs --list   print the errors, to fix some
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = join(ROOT, "packages");
const TSC = join(ROOT, "node_modules", "typescript", "bin", "tsc");

/**
 * The ceiling, per package, measured on 2026-09-04.
 *
 * A number rather than a total, so a package that cleans up cannot be spent by another
 * one getting worse. Lower one when you fix something; never raise one.
 */
const CEILING = {
  core: 45,
  cli: 20,
  evals: 0,
  mcp: 0,
  protocol: 0,
  sdk: 0,
  spec: 0,
  tui: 4,
};

/** `tsc` complains that test files sit outside `rootDir`. That is about layout, not types. */
const NOT_A_TYPE_ERROR = /error TS6059/;

function errorsIn(pkg) {
  const dir = join(PACKAGES, pkg);
  if (!existsSync(join(dir, "test"))) return { skipped: true, errors: [] };

  const config = join(dir, "tsconfig.__test-types.json");
  writeFileSync(
    config,
    JSON.stringify(
      {
        extends: "./tsconfig.json",
        compilerOptions: { noEmit: true, rootDir: ".", declaration: false, composite: false },
        include: ["src", "test"],
      },
      null,
      2,
    ),
  );
  try {
    // The compiler by its path, not through `npx` with `shell: true`: that combination
    // concatenates arguments into a command line instead of passing them, which node
    // warns about and which would break on the first path containing a space.
    execFileSync(process.execPath, [TSC, "-p", config], { cwd: dir, encoding: "utf-8" });
    return { skipped: false, errors: [] };
  } catch (e) {
    const out = String(e.stdout ?? "") + String(e.stderr ?? "");
    return {
      skipped: false,
      errors: out.split(/\r?\n/).filter((l) => /error TS/.test(l) && !NOT_A_TYPE_ERROR.test(l)),
    };
  } finally {
    rmSync(config, { force: true });
  }
}

const list = process.argv.includes("--list");
const packages = readdirSync(PACKAGES).filter((p) => existsSync(join(PACKAGES, p, "tsconfig.json")));

let failed = false;
for (const pkg of packages.sort()) {
  const { skipped, errors } = errorsIn(pkg);
  if (skipped) continue;
  const ceiling = CEILING[pkg];
  if (ceiling === undefined) {
    console.log(`${pkg}: ${errors.length} type error(s) in tests, and no ceiling declared. Add one.`);
    failed = true;
    continue;
  }
  const verdict = errors.length > ceiling ? "ABOVE" : errors.length < ceiling ? "below" : "at";
  console.log(`${pkg.padEnd(10)} ${String(errors.length).padStart(3)} type error(s) in tests, ${verdict} the ${ceiling} ceiling`);
  if (list) for (const line of errors) console.log(`    ${line}`);
  if (errors.length > ceiling) failed = true;
  if (errors.length < ceiling) {
    console.log(`    ↳ lower ${pkg}'s ceiling to ${errors.length} to keep the gain`);
    failed = true;
  }
}

if (failed) {
  console.log("\ntest types: the ratchet moved the wrong way, or a gain was not locked in.");
  process.exit(1);
}
console.log("\ntest types: no package is above its ceiling.");
