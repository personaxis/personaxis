/**
 * The live proof actually runs, and its checks actually pass.
 *
 * `personaxis proof` is the demonstration this project points people at, and it had
 * been crashing. The per-device split renamed the episodic log and the tamper scene
 * kept reaching for the name it had before, so scene four died on a path that has not
 * existed for versions. Nothing noticed, because nothing ran the command: the scenes
 * were exercised only by a person watching them.
 *
 * A proof nobody runs is a claim. This runs it the way somebody would, and fails when
 * any of its checks does, which is the only thing that keeps the two in step.
 *
 * `--quick --auto --demo` because CI has no terminal and no persona of its own, and
 * because a thousand hostile steps prove the same thing ten thousand do while leaving
 * the suite usable.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = fileURLToPath(new URL(".", import.meta.url));
const cli = join(here, "..", "dist", "index.js");

describe("the live proof", () => {
	it.skipIf(!existsSync(cli))("runs to the end with every check passing", () => {
		const output = execFileSync(process.execPath, [cli, "proof", "--quick", "--auto", "--demo"], {
			encoding: "utf-8",
			timeout: 120_000,
		});

		// Named individually rather than counted, because a scene that stops running
		// takes its checks with it and a count would go down quietly.
		expect(output).toMatch(/hostile steps.*0 escapes from the declared box \(T1\)/);
		expect(output).toMatch(/every admitted step ≤ max_step_delta/);
		expect(output).toMatch(/record entries hash-chained and verifiable/);
		expect(output).toMatch(/injection scan verdict: malicious/);
		expect(output).toMatch(/the coordinate crossed/);
		expect(output).toMatch(/certified minimum/);
		expect(output).toMatch(/chained, attributable record entry/);
		expect(output).toMatch(/pristine ledger verifies/);
		expect(output).toMatch(/verification fails AND names the spot/);
		expect(output).toMatch(/the fold over its record, held nowhere else/);
		expect(output).toMatch(/the edited entry is refused at/);

		// The scenes report their own failures as `✗`, so a run that finishes with one
		// is a run that proved something false.
		expect(output).not.toContain("✗");
		expect(output).toMatch(/all \d+ checks passed/);
		// The proof is a thousand hostile steps through the real engine and takes about
		// six seconds, so the five second default would fail it for being what it is.
	}, 180_000);
});

describe("whose persona the proof runs on", () => {
	// Without --persona, the lookup used to walk up the folders and stop at the user's own persona in the
	// home directory, then print its name and full path on the first line of a demonstration.
	it.skipIf(!existsSync(cli))("never reaches a persona above the current folder", () => {
		const home = mkdtempSync(join(tmpdir(), "pxs-proof-home-"));
		try {
			mkdirSync(join(home, ".personaxis"), { recursive: true });
			writeFileSync(
				join(home, ".personaxis", "personaxis.md"),
				"---\nidentity:\n  display_name: Private Home Persona\n---\n",
			);
			const work = join(home, "work");
			mkdirSync(work);
			const output = execFileSync(process.execPath, [cli, "proof", "--quick", "--auto"], {
				cwd: work,
				encoding: "utf-8",
				timeout: 120_000,
			});
			expect(output).not.toContain("Private Home Persona");
			expect(output).not.toContain(home);
			expect(output).toContain("the embedded demo persona");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	}, 180_000);
});
