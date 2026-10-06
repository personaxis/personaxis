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

describe("warming Pax when a turn is built (E161)", () => {
	/** Runs `code` in a fresh Node process that imports pax-process.ts, and returns how long it took to exit by itself. */
	async function exitsIn(code: string, dir: string): Promise<number> {
		const { spawn } = await import("node:child_process");
		const module = join(import.meta.dirname, "..", "src", "judge", "pax-process.ts").replace(/\\/g, "/");
		const started = Date.now();
		const child = spawn(process.execPath, ["--input-type=module", "-e", `const m = await import("file:///${module.replace(/^\//, "")}"); ${code}`], { env: { ...process.env, PERSONAXIS_PAX_DIR: dir }, stdio: "ignore" });
		const exited = await new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => resolve(false), 8000);
			child.on("exit", () => {
				clearTimeout(timer);
				resolve(true);
			});
		});
		if (!exited) child.kill();
		return exited ? Date.now() - started : Number.POSITIVE_INFINITY;
	}

	// A Pax that never answers, so only what the request holds can keep the process alive.
	const SILENT = `process.stdin.resume();`;

	it("does not keep a one-shot process alive while the models load for nobody", async () => {
		const dir = fakePax(SILENT);
		expect(await exitsIn("m.warmPax();", dir)).toBeLessThan(5000);
	});

	it("while a question that somebody awaits does keep it alive", async () => {
		const dir = fakePax(SILENT);
		expect(await exitsIn(`await m.paxProcess().request({ op: "judge" });`, dir)).toBe(Number.POSITIVE_INFINITY);
	}, 15000);
});
