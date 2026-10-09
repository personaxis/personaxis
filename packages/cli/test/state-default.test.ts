/**
 * E170: `state` with no `-f` works on the persona in scope, as `lint`, `goal` and `status` do.
 * E171: `state rewind <n>` and `goal <text>`, the shell doors two retired REPL verbs point at.
 *
 * Seen on 2026-10-03 in the review before the first release: in a folder as `create` leaves it,
 * `state show` read `./PERSONA.md`, the compiled prose, and reported an empty `persona@0.0.0` in
 * `locked`, with no error.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { writeTestPersona } from "./helpers/test-persona.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "dist", "index.js");
const FIELD = "affect.baseline.core_affect.valence";
let dir = "";
afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = "";
});

const cli = (...args: string[]) => {
	const run = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, PERSONAXIS_NO_UPDATE_CHECK: "1", NO_COLOR: "1" } });
	return { code: run.status, out: run.stdout, err: run.stderr };
};
const valueOf = () => (JSON.parse(cli("state", "show", "--json").out) as { values: Record<string, number> }).values[FIELD];

/** A folder as `create` leaves it: the spec under `.personaxis/`, the compiled prose at the root. */
function project(): void {
	dir = mkdtempSync(join(tmpdir(), "pxs-state-"));
	writeTestPersona(dir, "Vega");
	writeFileSync(join(dir, "PERSONA.md"), "# Vega\n\nVega is a careful designer who checks before shipping.\n");
}

describe.skipIf(!existsSync(CLI))("state on the persona in scope (E170)", () => {
	it("reads .personaxis/personaxis.md, not the compiled PERSONA.md, and keeps state.json beside it", () => {
		project();
		const shown = JSON.parse(cli("state", "show", "--json").out) as { persona_id: string };
		expect(shown.persona_id).toBe("vega");
		expect(existsSync(join(dir, ".personaxis", "state.json"))).toBe(true);
		expect(existsSync(join(dir, "state.json"))).toBe(false);
	}, 30_000);

	it("an explicit -f still wins", () => {
		project();
		const run = cli("state", "show", "--json", "-f", join(dir, "PERSONA.md"));
		expect((JSON.parse(run.out) as { persona_id: string }).persona_id).not.toBe("vega");
	}, 30_000);
});

describe.skipIf(!existsSync(CLI))("the shell doors of /rewind and /goal (E171)", () => {
	it("state rewind 1 undoes the last move with a new recorded move", () => {
		project();
		const before = valueOf();
		expect(cli("state", "mutate", "--field", FIELD, "--delta", "0.05", "--reason", "test move").code).toBe(0);
		expect(valueOf()).not.toBe(before);
		expect(cli("state", "rewind", "1", "--dry-run").out).toContain("nothing written");
		expect(valueOf()).not.toBe(before);

		expect(cli("state", "rewind", "1").code).toBe(0);
		expect(valueOf()).toBe(before);
		// Appended, never truncated: the move and the rewind are both in the record.
		const record = readFileSync(join(dir, ".personaxis", "record.jsonl"), "utf8").trim().split(/\r?\n/);
		expect(record.filter((l) => l.includes(FIELD)).length).toBeGreaterThanOrEqual(2);
	}, 60_000);

	it("goal <text> sets the standing goal and --clear removes it", () => {
		project();
		cli("goal", "Ship", "the", "onboarding", "redesign");
		expect(JSON.parse(cli("goal", "--json").out).goal).toBe("Ship the onboarding redesign");
		cli("goal", "--clear");
		expect(JSON.parse(cli("goal", "--json").out).goal).toBe(null);
	}, 30_000);
});
