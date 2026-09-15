/**
 * E95: the calls the CLI makes after a turn, against what a reasoning model on a strict endpoint does with them.
 *
 * Measured on 2026-09-15 with Cohere's `command-a-plus-05-2026`: the session namer spent its 16 tokens thinking and the
 * session was named with the cut reasoning, and the appraiser's first strategy got HTTP 400 on every turn because one
 * property of its schema named no type. These pin the two fixes without a network.
 */

import { describe, expect, it } from "vitest";
import { APPRAISAL_JSON_SCHEMA, LlmAppraiser, nameSession, portableJsonSchema } from "../src/index.js";

type Node = { type?: unknown; properties?: Record<string, Node>; items?: Node; anyOf?: unknown; enum?: unknown };

/** What Cohere's strict validator refused, as measured: a property with no type, an object with no properties, a type list with object. */
function whatAStrictValidatorRejects(node: Node, at = "$"): string[] {
	const found: string[] = [];
	if (node.type === "object" && node.properties === undefined) found.push(`${at}: object without properties`);
	if (Array.isArray(node.type) && node.type.includes("object")) found.push(`${at}: type list with object`);
	for (const [name, prop] of Object.entries(node.properties ?? {})) {
		if (prop.type === undefined && prop.anyOf === undefined && prop.enum === undefined) found.push(`${at}.${name}: no type`);
		found.push(...whatAStrictValidatorRejects(prop, `${at}.${name}`));
	}
	if (node.items) found.push(...whatAStrictValidatorRejects(node.items, `${at}[]`));
	return found;
}

function reply(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const input = { observation: "The person asked for a shorter answer.", source: "user" as const, personaBody: "You are Clio.", mutableFields: [] };

describe("E95: the appraiser's schema travels to a strict endpoint", () => {
	it("leaves nothing a strict validator refuses", () => {
		expect(whatAStrictValidatorRejects(portableJsonSchema(APPRAISAL_JSON_SCHEMA) as Node)).toEqual([]);
	});

	it("sends a property that takes any value as a string, and keeps every other shape", () => {
		const portable = portableJsonSchema(APPRAISAL_JSON_SCHEMA) as Node;
		const edit = portable.properties?.selfEdits?.items?.properties;
		expect(edit?.toValue).toEqual({ type: "string" });
		expect(edit?.targetPath).toEqual({ type: "string" });
		// An empty properties map is a map, not a schema that takes any value.
		expect(portableJsonSchema({ type: "object", properties: {} })).toEqual({ type: "object", properties: {} });
	});

	it("reads a self-edit's value back from JSON under the schema, and keeps text that is not JSON", async () => {
		const sent: unknown[] = [];
		const appraiser = new LlmAppraiser({
			endpoint: "http://model.test/v1",
			model: "m",
			fetchImpl: (async (_url: string, init: RequestInit) => {
				sent.push(JSON.parse(String(init.body)).response_format?.type);
				const content = {
					appraisal: "a durable preference",
					mutations: [],
					memories: [],
					selfEdits: [
						{ targetPath: "a.envelope", toValue: '{"mean":0.4}', rationale: "r" },
						{ targetPath: "b.threshold", toValue: "0.1", rationale: "r" },
						{ targetPath: "c.prose", toValue: "Be brief.", rationale: "r" },
					],
					confidence: 0.9,
				};
				return reply({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(content) } }] });
			}) as typeof fetch,
		});

		const signal = await appraiser.appraise(input);

		expect(sent).toEqual(["json_schema"]);
		expect(signal.selfEdits?.map((edit) => edit.toValue)).toEqual([{ mean: 0.4 }, 0.1, "Be brief."]);
	});

	it("takes a string as the value itself when the schema was not sent", async () => {
		const sent: unknown[] = [];
		const appraiser = new LlmAppraiser({
			endpoint: "http://model.test/v1",
			model: "m",
			fetchImpl: (async (_url: string, init: RequestInit) => {
				const format = JSON.parse(String(init.body)).response_format?.type;
				sent.push(format);
				if (format === "json_schema") return reply({ message: "invalid request" }, 400);
				const content = { appraisal: "x", mutations: [], memories: [], selfEdits: [{ targetPath: "b.label", toValue: "0.1", rationale: "r" }], confidence: 0.9 };
				return reply({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(content) } }] });
			}) as typeof fetch,
		});

		const signal = await appraiser.appraise(input);

		expect(sent).toEqual(["json_schema", "json_object"]);
		expect(signal.selfEdits?.[0]?.toValue).toBe("0.1");
	});
});

describe("E95: a session title cut at the cap is not a title", () => {
	const llm = (finish: string, content: string) => ({
		endpoint: "http://model.test/v1",
		model: "m",
		fetchImpl: (async () => reply({ choices: [{ finish_reason: finish, message: { content } }] })) as typeof fetch,
	});

	it("refuses a reply that stopped at the token cap, so the deterministic name stays", async () => {
		await expect(nameSession(llm("length", 'The user says: "First message: Design a small arcade game an'), "Design a game")).rejects.toThrow(/cut off/);
	});

	it("still takes a title that finished", async () => {
		await expect(nameSession(llm("stop", "Arcade Game Plan"), "Design a game")).resolves.toBe("Arcade Game Plan");
	});
});
