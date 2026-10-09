/**
 * E175: `create --provider agent` hands the authoring to the coding agent, one stage at a time.
 *
 * Until 2026-10-03 the agent provider sent `create` down the no-model path. Since 2026-10-07 every part of
 * the persona is authored by a model (H15), one call per stage, so the agent handoff is a conversation in
 * files: each run stops at the first stage without an answer and leaves its prompt, the agent writes the
 * answer beside it, and the same command, run again, replays every answer already written (the prompts are
 * deterministic, so their hashes match) and stops at the next stage, until the persona exists. Then the
 * same for its PERSONA.md, which the agent writes too; re-running over the same definition must not archive
 * it as a replaced persona.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { STAGES } from "@personaxis/core";

import { runCli } from "./helpers/fake-model.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "dist", "index.js");
const RECORDED = JSON.parse(readFileSync(join(HERE, "fixtures", "genesis-terse-reviewer.json"), "utf8")) as { brief: string; answers: Record<string, unknown>; document: string };
let dir = "";
afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = "";
});

// Async on purpose: eleven synchronous runs in a row block this worker's event loop for twenty seconds, and
// vitest reports the worker as unresponsive (seen 2026-10-07).
const create = () =>
	runCli(CLI, ["create", "rev", RECORDED.brief, "--provider", "agent", "--yes"], {
		cwd: dir,
		env: { PERSONAXIS_HOME: join(dir, "home"), NO_COLOR: "1", PERSONAXIS_ENDPOINT: "", PERSONAXIS_MODEL: "", PERSONAXIS_API_KEY: "" },
	});

/** The stage a prompt asks for, read the way an agent reads it: from the keys it names. */
const stageOf = (prompt: string) => {
	const keys = /^You are authoring one part of an AI persona: .*\(keys: ([^)]+)\)\.$/m.exec(prompt)?.[1];
	return STAGES.find((s) => s.keys.join(", ") === keys)?.id;
};

describe.skipIf(!existsSync(CLI))("create with the agent provider (E175)", () => {
	it("stops at each stage's handoff and at the document's, then writes the persona from the agent's answers", async () => {
		dir = mkdtempSync(join(tmpdir(), "pxs-create-agent-"));
		const tmp = join(dir, ".personaxis", ".tmp");
		const spec = join(dir, ".personaxis", "personas", "rev", "personaxis.md");
		const doc = join(dirname(spec), "PERSONA.md");
		const asked: string[] = [];

		for (let round = 0; round <= STAGES.length + 2 && !existsSync(doc); round += 1) {
			const r = await create();
			expect(r.code, r.out).toBe(0);
			if (existsSync(doc)) break;
			expect(r.stdout).toContain("needs the active coding agent");
			const waiting = readdirSync(tmp).filter((f) => f.endsWith(".prompt.md") && !existsSync(join(tmp, f.replace(".prompt.md", ".out.md"))));
			expect(waiting).toHaveLength(1);
			const prompt = readFileSync(join(tmp, waiting[0]!), "utf8");
			const answer = join(tmp, waiting[0]!.replace(".prompt.md", ".out.md"));
			if (prompt.startsWith("You write the compiled document for")) {
				asked.push("PERSONA.md");
				writeFileSync(answer, RECORDED.document);
				continue;
			}
			if (prompt.startsWith("You are checking a whole AI persona")) {
				asked.push("coherence");
				writeFileSync(answer, JSON.stringify(RECORDED.answers.coherence));
				continue;
			}
			expect(prompt).toContain("JSON Schema");
			const stage = stageOf(prompt);
			expect(stage, prompt.slice(0, 200)).toBeDefined();
			asked.push(stage!);
			writeFileSync(answer, JSON.stringify(RECORDED.answers[stage!]));
		}

		expect(asked).toEqual([...STAGES.map((s) => s.id), "coherence", "PERSONA.md"]);
		expect(readFileSync(doc, "utf8")).toContain("# You are Terse Code Reviewer");
		// The re-runs wrote the same definition again; none of them was a replaced persona.
		expect(existsSync(join(dirname(spec), "previous"))).toBe(false);
		const written = readFileSync(spec, "utf8");
		expect(written).toContain("canonical_id: rev");
		expect(readFileSync(join(dirname(spec), "creation-report.md"), "utf8")).toContain("## Each stage");
	}, 180_000);
});
