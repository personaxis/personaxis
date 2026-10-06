/**
 * E175: `create --provider agent` hands the extraction to the coding agent instead of building the
 * persona from labeled defaults.
 *
 * Until 2026-10-03 the agent provider sent `create` down the no-model path, the same one that left the
 * benchmark's Gamewright with eighteen defaults. Now the first run stops and leaves the prompt, as
 * `compile` does, and the second run, with the answer written, creates the persona from it.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "dist", "index.js");
const BRIEF = "A careful product designer who checks before shipping.";
const ANSWER = {
	displayName: "Vega",
	role: "product designer",
	purpose: "Design product interfaces and check every one before it ships.",
	tone: "calm and exact",
	traits: [{ name: "conscientiousness", mean: 0.85, evidence: "checks before shipping" }],
	values: [{ name: "quality", weight: 0.85, evidence: "careful" }],
};
let dir = "";
afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = "";
});

const create = () => {
	const env: NodeJS.ProcessEnv = { ...process.env, PERSONAXIS_HOME: join(dir, "home"), PERSONAXIS_NO_UPDATE_CHECK: "1", NO_COLOR: "1" };
	for (const k of ["PERSONAXIS_ENDPOINT", "PERSONAXIS_MODEL", "PERSONAXIS_API_KEY"]) delete env[k];
	return spawnSync(process.execPath, [CLI, "create", "vega", "--from-prompt", BRIEF, "--provider", "agent", "--yes"], { cwd: dir, encoding: "utf8", env });
};

describe.skipIf(!existsSync(CLI))("create with the agent provider (E175)", () => {
	it("stops at the handoff, then creates the persona from the agent's answer", () => {
		dir = mkdtempSync(join(tmpdir(), "pxs-create-agent-"));

		const first = create();
		expect(first.status).toBe(0);
		expect(first.stdout).toContain("needs the active coding agent");
		const tmp = join(dir, ".personaxis", ".tmp");
		const prompt = readdirSync(tmp).find((f) => f.endsWith(".prompt.md"));
		expect(prompt).toBeDefined();
		expect(existsSync(join(dir, ".personaxis", "personas", "vega"))).toBe(false);
		expect(readFileSync(join(tmp, prompt!), "utf8")).toContain("JSON Schema");

		writeFileSync(join(tmp, prompt!.replace(".prompt.md", ".out.md")), JSON.stringify(ANSWER));
		const second = create();
		expect(second.status).toBe(0);
		const spec = readFileSync(join(dir, ".personaxis", "personas", "vega", "personaxis.md"), "utf8");
		expect(spec).toContain(ANSWER.purpose);
		expect(spec).toContain("calm_and_exact");
		expect(readFileSync(join(dir, ".personaxis", "personas", "vega", "creation-report.md"), "utf8")).not.toContain("Worked around");
	}, 90_000);
});
