/**
 * E134: what the engine found broken in what a turn delivered is said by Personaxis under the reply.
 *
 * A persona can close a turn saying it fixed something the engine has just run and seen fail (`e132co`). The
 * reply stays the model's; these check the product's own line: present when a check failed, in the words the
 * check used, with the path as a person reads it, and absent when everything passed.
 */
import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { engineVerdictLines } from "../src/repl/render.js";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const cwd = join("C:", "work", "cat-game");
const page = join(cwd, "game.html");

describe("the engine's own line under the reply (E134)", () => {
	it("says what failed, in the check's words, with the path relative to the project", () => {
		const lines = engineVerdictLines(
			{
				checks: [
					{
						what: page,
						how: "ran it for 10 seconds of frames",
						passed: false,
						reason: `${page} does NOT run: on load, at line 76 of the file, which reads \`}\`: SyntaxError: missing ) after argument list`,
					},
				],
			},
			cwd,
		).map(strip);
		expect(lines).toEqual([
			"  ⚠ Checked by Personaxis: game.html does NOT run: on load, at line 76 of the file, which reads `}`: SyntaxError: missing ) after argument list",
		]);
	});

	it("names the file when the check's own words do not", () => {
		const [line] = engineVerdictLines(
			{ checks: [{ what: join(cwd, "levels.json"), how: "parsed it as JSON", passed: false, reason: "Unexpected token } in JSON at position 42" }] },
			cwd,
		).map(strip);
		expect(line).toBe("  ⚠ Checked by Personaxis: levels.json: Unexpected token } in JSON at position 42");
	});

	it("says nothing when everything delivered passed, or nothing was delivered", () => {
		expect(engineVerdictLines({ checks: [{ what: page, how: "ran it", passed: true }] }, cwd)).toEqual([]);
		expect(engineVerdictLines(undefined, cwd)).toEqual([]);
	});
});
