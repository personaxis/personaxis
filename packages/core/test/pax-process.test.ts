/**
 * Pax's own process: the engine speaks to it over stdin and stdout and never imports its code. A fake `serve.mjs`
 * stands in for Pax here, so this checks the protocol and not the models.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { judgeFromEnv } from "../src/judge/judge.js";

const dirs: string[] = [];
afterEach(() => {
	delete process.env.PERSONAXIS_PAX_DIR;
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A Pax directory whose `serve.mjs` is `body`. */
function fakePax(body: string): string {
	const dir = mkdtempSync(join(tmpdir(), "pxs-pax-"));
	dirs.push(dir);
	writeFileSync(join(dir, "serve.mjs"), body);
	process.env.PERSONAXIS_PAX_DIR = dir;
	return dir;
}

const ECHO = `
import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).on("line", (line) => {
	const r = JSON.parse(line);
	// Answers in reverse order of arrival when two come together, so pairing by id is what is tested.
	setTimeout(() => process.stdout.write(JSON.stringify({ id: r.id, ok: true, engine: "fake-pax@1234567", answers: { in_role: { noul: r.state.request === "a" ? 0.9 : 0.1 } } }) + "\\n"), r.state.request === "a" ? 60 : 5);
});
`;

describe("Pax's own process", () => {
	it("is absent without the variable, and answers each question with its own answer when it is set", async () => {
		expect(await judgeFromEnv()).toBeUndefined();
		fakePax(ECHO);
		const judge = (await judgeFromEnv())!;
		const questions = { in_role: { type: "noul" as const, instructions: "In role?" } };
		const [a, b] = await Promise.all([judge.ask({ request: "a" }, questions), judge.ask({ request: "b" }, questions)]);
		expect(a.in_role).toEqual({ kind: "noul", p: 0.9 });
		expect(b.in_role).toEqual({ kind: "noul", p: 0.1 });
		expect(judge.engine).toBe("fake-pax@1234567");
	});

	it("fails the question, and does not hang, when the process dies", async () => {
		fakePax(`process.exit(3);`);
		const judge = (await judgeFromEnv())!;
		await expect(judge.ask({ request: "a" }, { in_role: { type: "noul", instructions: "In role?" } })).rejects.toThrow(/ended/);
	});
});
