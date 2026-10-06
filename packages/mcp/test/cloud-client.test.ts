/**
 * The hosted-registry client, against a fake fetch.
 *
 * These four calls are what an agent will use to find and load a persona from the hub.
 * They are not mounted in this release (`HOSTED_OFFERED` is false), so nothing in the
 * server exercised them and the package fell under its own coverage floor. Tested
 * here directly: the URL each call builds, the headers, the body, and what an error
 * from the API turns into.
 */

import { describe, expect, it } from "vitest";

import {
	CloudApiError,
	evaluateAgainstPersona,
	fetchPersona,
	listPersonas,
	type CloudConfig,
} from "../src/cloud.js";

const cfg: CloudConfig = { apiKey: "k-test", baseUrl: "https://hub.example", userAgent: "personaxis-mcp/0" };

interface Seen {
	url: string;
	init: RequestInit;
}

/** A fetch that records what it was asked and answers with the given status and body. */
function fakeFetch(status: number, body: unknown, seen: Seen[]): typeof fetch {
	return (async (url: string | URL | Request, init?: RequestInit) => {
		seen.push({ url: String(url), init: init ?? {} });
		return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
	}) as typeof fetch;
}

describe("the hosted-registry client", () => {
	it("lists personas with only the filters that were given", async () => {
		const seen: Seen[] = [];
		await listPersonas(cfg, { search: "security review", limit: 5 }, fakeFetch(200, { items: [] }, seen));
		expect(seen[0]!.url).toBe("https://hub.example/api/v1/personas?search=security+review&limit=5");
		const headers = seen[0]!.init.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer k-test");
		expect(headers["Content-Type"]).toBeUndefined();

		await listPersonas(cfg, {}, fakeFetch(200, { items: [] }, seen));
		expect(seen[1]!.url).toBe("https://hub.example/api/v1/personas");
	});

	it("encodes the slug when fetching one persona", async () => {
		const seen: Seen[] = [];
		const persona = await fetchPersona(cfg, "a b/c", fakeFetch(200, { slug: "a b/c" }, seen));
		expect(seen[0]!.url).toBe("https://hub.example/api/v1/personas/a%20b%2Fc");
		expect(persona.slug).toBe("a b/c");
	});

	it("posts the response to evaluate as JSON", async () => {
		const seen: Seen[] = [];
		await evaluateAgainstPersona(cfg, { personaSlug: "auditor", response: "done" }, fakeFetch(200, { ok: true }, seen));
		expect(seen[0]!.init.method).toBe("POST");
		expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ personaSlug: "auditor", response: "done" });
		expect((seen[0]!.init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
	});

	it("turns an API error into a CloudApiError with the API's own code and message", async () => {
		const err = await fetchPersona(
			cfg,
			"missing",
			fakeFetch(404, { error: { code: "NOT_FOUND", message: "no such persona" } }, []),
		).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(CloudApiError);
		expect((err as CloudApiError).status).toBe(404);
		expect((err as CloudApiError).code).toBe("NOT_FOUND");
		expect((err as CloudApiError).message).toBe("no such persona");
	});

	it("still reports the status when the error body is not JSON", async () => {
		const err = await listPersonas(cfg, {}, fakeFetch(502, "bad gateway", [])).catch((e: unknown) => e);
		expect((err as CloudApiError).code).toBe("HTTP_ERROR");
		expect((err as CloudApiError).message).toBe("GET /api/v1/personas failed with 502");
	});
});
