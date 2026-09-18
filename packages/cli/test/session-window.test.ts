/**
 * The window a SESSION measures itself against, when somebody declared one.
 *
 * `E86` made a declared context window win inside a turn, over the lookup table and over the background
 * refresh from the endpoint, because the only reason to write one down is to make the run behave as if the
 * window were that size. The meter a whole session shares was left out of that, and it is the one that
 * matters most here: `maybeAutoCompact` reads it, so a window declared and then quietly overwritten meant a
 * conversation compacting at some other size than the one that was asked for.
 *
 * Found on 2026-09-18 while building the bench instrument for `E100`, which declares a small window so an
 * ordinary conversation reaches the threshold. It did not reach it, and the reason was here rather than in
 * the conversation.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeMeter } from "../src/repl/config.js";

let dir: string;
let cwd: string;
const saved: Record<string, string | undefined> = {};

/** A project config in the working directory, which is the layer a bench run and a project both use. */
function declaring(window?: number) {
	mkdirSync(join(dir, ".personaxis"), { recursive: true });
	writeFileSync(
		join(dir, ".personaxis", "config.json"),
		JSON.stringify({
			profiles: { local: { endpoint: "http://127.0.0.1:9/v1", model: "some-model", ...(window === undefined ? {} : { contextWindow: window }) } },
			defaultProfile: "local",
		}),
	);
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pxs-session-window-"));
	cwd = process.cwd();
	for (const key of ["PERSONAXIS_HOME", "PERSONAXIS_ENDPOINT", "PERSONAXIS_MODEL", "PERSONAXIS_API_KEY"]) saved[key] = process.env[key];
	process.env.PERSONAXIS_HOME = join(dir, "home");
	for (const key of ["PERSONAXIS_ENDPOINT", "PERSONAXIS_MODEL", "PERSONAXIS_API_KEY"]) delete process.env[key];
	process.chdir(dir);
});

afterEach(() => {
	process.chdir(cwd);
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(dir, { recursive: true, force: true });
});

describe("the window a session measures itself against", () => {
	it("is the one that was declared, not the one the table guesses for that model", () => {
		declaring(6_000);

		expect(makeMeter().limit).toBe(6_000);
	});

	it("falls back to the table when nobody declared one, which is right for ordinary use", () => {
		declaring();

		// Whatever the table says for an unknown model, it is not the number above and it is a real window.
		const limit = makeMeter().limit;
		expect(limit).toBeGreaterThan(0);
		expect(limit).not.toBe(6_000);
	});
});
