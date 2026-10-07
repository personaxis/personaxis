/**
 * One way to get an evolver, and what it decides.
 *
 * The turn loop had two callers that had drifted. This loop has four: the `observe`
 * command, the REPL, the protocol host and the SDK, each writing the same three lines
 * to build the same object. What these pin is the split, and specifically the one
 * knob that stopped being optional.
 *
 * The appraiser is the persona's, resolved from what it declared, and no caller can
 * pass a different one. Recompiling on drift is the caller's, and no caller can arrive
 * at "no" by forgetting: the field is required, so `null` is something somebody wrote.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolveModel = vi.hoisted(() => vi.fn());
vi.mock("../src/model-config.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/model-config.js")>()),
	resolveModel,
}));

import { ModelRequiredError } from "../src/model-config.js";
import { loadPersona, type StateFile } from "../src/persona.js";
import { appraiserFor, evolverFor } from "../src/run/evolving.js";

let dir: string;
let personaPath: string;

beforeEach(() => {
	resolveModel.mockReset();
	resolveModel.mockReturnValue(undefined);
	dir = mkdtempSync(join(tmpdir(), "pxs-evolving-"));
	personaPath = join(dir, "personaxis.md");
	writeFileSync(
		personaPath,
		`---
apiVersion: persona.dev/v1
metadata: { name: ev, version: 1.0.0 }
identity: { canonical_id: ev }
improvement_policy: { mode: suggesting }
affect:
  baseline:
    mood:
      tone: { mean: 0.0, range: [-1, 1] }
---
body
`,
	);
	const handle = loadPersona(personaPath);
	const state: StateFile = {
		schema_version: "1.1.0",
		persona_id: "ev",
		persona_version: "1.0.0",
		values: { "mood.tone": 0 },
		mutation_log: [],
	};
	writeFileSync(handle.statePath, JSON.stringify(state, null, 2));
});

afterEach(() => {
	vi.unstubAllGlobals();
	rmSync(dir, { recursive: true, force: true });
});

const facts = () => ({ personaPath, frontmatter: { runtime: {} } as Record<string, unknown> });

describe("the appraiser is the persona's", () => {
	const input = {
		observation: "the review found two missing tests",
		source: "user" as const,
		personaBody: "You are Lens.",
		mutableFields: [],
	};

	afterEach(() => vi.unstubAllGlobals());

	it("asks the model the persona declared, at the moment it appraises", async () => {
		resolveModel.mockReturnValue({ endpoint: "http://model.invalid/v1", model: "m", apiKey: "k" });
		const urls: string[] = [];
		vi.stubGlobal("fetch", async (url: string) => {
			urls.push(String(url));
			throw new Error("network off in tests");
		});

		await appraiserFor(facts()).appraise(input).catch(() => undefined);

		expect(urls.some((u) => u.startsWith("http://model.invalid/v1"))).toBe(true);
	});

	it("refuses when there is no model, instead of guessing from word counts", async () => {
		// Decided by David on 2026-10-07: an appraisal is a model's judgement or it is nothing.
		// The keyword appraiser that stood in for it counted words like "good" and "fail".
		await expect(appraiserFor(facts()).appraise(input)).rejects.toBeInstanceOf(ModelRequiredError);
	});

	it("picks up a model configured after the session started", async () => {
		const appraiser = appraiserFor(facts());
		await expect(appraiser.appraise(input)).rejects.toBeInstanceOf(ModelRequiredError);

		resolveModel.mockReturnValue({ endpoint: "http://model.invalid/v1", model: "m", apiKey: "k" });
		vi.stubGlobal("fetch", async () => {
			throw new Error("network off in tests");
		});
		await expect(appraiser.appraise(input)).rejects.not.toBeInstanceOf(ModelRequiredError);
	});

	it("asks about THIS persona, not about whatever the process is pointed at", async () => {
		await appraiserFor({ ...facts(), cwd: "/somewhere/else" }).appraise(input).catch(() => undefined);

		expect(resolveModel).toHaveBeenCalledWith(
			expect.objectContaining({ personaPath, cwd: "/somewhere/else" }),
		);
	});

	it("leaves the working directory unnamed when the caller did not name one", async () => {
		// `resolveModel` defaults it, and passing an explicit `undefined` is not the
		// same as passing nothing to a function that reads its own default.
		await appraiserFor(facts()).appraise(input).catch(() => undefined);

		expect(resolveModel).toHaveBeenCalledWith(expect.not.objectContaining({ cwd: undefined }));
	});
});

describe("recompiling on drift is a decision, never an omission", () => {
	it("takes a hook and keeps it", () => {
		const recompile = vi.fn(async () => {});

		expect(() => evolverFor(facts(), { recompile })).not.toThrow();
	});

	it("takes a written no", () => {
		// The two callers that mean this are a library and a protocol host, and both
		// have a reason: spending somebody's model budget on a rewrite they did not
		// ask for is not a decision a library gets to make. What the type forbids is
		// reaching the same place by forgetting.
		expect(() => evolverFor(facts(), { recompile: null })).not.toThrow();
	});
});

describe("what the consumer holds", () => {
	it("is an evolver and not the loop", () => {
		// A consumer holding the loop has to be edited again when the loop behind it
		// changes, which is the whole reason this seam exists.
		const evolver = evolverFor(facts(), { recompile: null });

		expect(evolver).toHaveProperty("observe");
		expect(evolver).not.toHaveProperty("tick");
		expect(evolver).not.toHaveProperty("bus");
	});

	it("names the persona, so a caller does not reload the file to print it", () => {
		const evolver = evolverFor(facts(), { recompile: null });

		expect(evolver.persona.personaPath).toBe(personaPath);
	});

	it("subscribes before the first cycle, so nothing is missed by attaching late", async () => {
		// The old shape handed back an object and every caller then did `loop.bus.on`.
		// That works only because all four happened to remember, and a caller that
		// attached after its first tick would have seen an empty stream with no error.
		resolveModel.mockReturnValue({ endpoint: "http://model.invalid/v1", model: "m", apiKey: "k" });
		const appraisal = { appraisal: "", mutations: [], memories: [], confidence: 0.9 };
		vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(appraisal) } }] }), { status: 200 }));
		const seen: string[] = [];
		const evolver = evolverFor(facts(), {
			recompile: null,
			onEvent: (event) => seen.push(event.type),
		});

		await evolver.observe({ observation: "hello", source: "user" });

		expect(seen[0]).toBe("observe");
	});
});
