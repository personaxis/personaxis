/**
 * The four tools that talk to the hosted registry, in the one server (`R9`).
 *
 * They lived in the SaaS repository as a second package, and the second package was
 * named `@personaxis/mcp` too, with the same `personaxis-mcp` binary. Two publishable
 * packages under one name is an accident waiting for whoever runs `pnpm -r publish`
 * without reading, and unifying removes it instead of renaming half of it.
 *
 * They were never part of that repository in any technical sense: their only imports
 * were the MCP SDK and `zod`, and their whole job is `fetch` against `/api/v1/...`.
 * The ADR of 2026-08-30 says it plainly: they lived there by historical accident.
 *
 * ## Without a key they degrade, they do not stop the server
 *
 * The thing that breaks if it is missed, and the ADR names it: the old client THREW
 * when `PERSONAXIS_API_KEY` was absent, at startup. In a single server that would kill
 * the process for somebody who only wants the sixteen local tools, which need no
 * account at all. So each of these four answers with where to get a key, and the rest
 * of the server is unaffected.
 *
 * That split is not a workaround. It is the same one the business already has: what
 * works with nothing but this machine, and what needs an account.
 */

import { z } from "zod";

/** Where the hosted API lives, unless somebody points this elsewhere. */
const DEFAULT_BASE_URL = "https://personaxis.com";

export interface CloudConfig {
	readonly apiKey: string;
	readonly baseUrl: string;
	readonly userAgent: string;
}

/**
 * The account credentials, or nothing.
 *
 * Returns rather than throws, which is the whole of `R9`'s one technical problem: a
 * missing key is a fact about which half of the product this user is using, not an
 * error that should take a local server down with it.
 */
export function cloudConfig(env: NodeJS.ProcessEnv = process.env): CloudConfig | null {
	const apiKey = env.PERSONAXIS_API_KEY;
	if (!apiKey) return null;

	return {
		apiKey,
		baseUrl: (env.PERSONAXIS_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
		userAgent: `personaxis-mcp/${env.PERSONAXIS_MCP_VERSION ?? "0"}`,
	};
}

/** What a tool says when the account half is not configured. */
export const NO_KEY_MESSAGE =
	"This tool talks to the hosted Personaxis registry and needs an account key. " +
	"Set PERSONAXIS_API_KEY (get one at https://personaxis.com/settings) and restart " +
	"this server. Everything that works on this machine alone keeps working without it.";

export class CloudApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "CloudApiError";
	}
}

async function request<T>(
	cfg: CloudConfig,
	method: "GET" | "POST",
	path: string,
	body?: unknown,
	fetchImpl: typeof fetch = fetch,
): Promise<T> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${cfg.apiKey}`,
		"User-Agent": cfg.userAgent,
		Accept: "application/json",
	};
	if (body != null) headers["Content-Type"] = "application/json";

	const res = await fetchImpl(`${cfg.baseUrl}${path}`, {
		method,
		headers,
		body: body != null ? JSON.stringify(body) : undefined,
	});

	if (!res.ok) {
		let code = "HTTP_ERROR";
		let message = `${method} ${path} failed with ${res.status}`;
		try {
			const problem = (await res.json()) as { error?: { code?: string; message?: string } };
			code = problem.error?.code ?? code;
			message = problem.error?.message ?? message;
		} catch {
			/* the API said nothing readable; the status is still the answer */
		}
		throw new CloudApiError(res.status, code, message);
	}

	return (await res.json()) as T;
}

export interface PersonaSpec {
	slug: string;
	displayName: string;
	description: string;
	version: { semver: string; changelog: string };
	spec: { content: string; mimeType: string; byteSize: number } | null;
	/**
	 * Spec v0.5.0+ sibling, absent on legacy v0.4 personas.
	 *
	 * NEVER inlined into a system prompt. It is the governance document, not identity,
	 * and `personas_apply` below strips its equivalents out of the spec for the same
	 * reason.
	 */
	policy?: { content: string; mimeType: string; byteSize: number } | null;
}

export function listPersonas(
	cfg: CloudConfig,
	params: { search?: string; category?: string; limit?: number } = {},
	fetchImpl?: typeof fetch,
) {
	const query = new URLSearchParams();
	if (params.search) query.set("search", params.search);
	if (params.category) query.set("category", params.category);
	if (params.limit) query.set("limit", String(params.limit));
	const qs = query.toString();

	return request<unknown>(cfg, "GET", `/api/v1/personas${qs ? `?${qs}` : ""}`, undefined, fetchImpl);
}

export function fetchPersona(cfg: CloudConfig, slug: string, fetchImpl?: typeof fetch) {
	return request<PersonaSpec>(
		cfg,
		"GET",
		`/api/v1/personas/${encodeURIComponent(slug)}`,
		undefined,
		fetchImpl,
	);
}

export function evaluateAgainstPersona(
	cfg: CloudConfig,
	body: { personaSlug: string; response: string; role?: string },
	fetchImpl?: typeof fetch,
) {
	return request<unknown>(cfg, "POST", "/api/v1/runtime/evaluate", body, fetchImpl);
}

/**
 * Frontmatter keys that describe how a persona is GOVERNED rather than who it is.
 *
 * Stripped before a spec is handed to a model as identity. A legacy v0.4 document
 * carries these inline, and pasting assertions and evaluation policy into a system
 * prompt hands the model the test it is about to be marked against.
 */
const OPERATIONAL_KEYS = new Set(["assertions", "runtime", "evaluation", "improvement_policy"]);

/**
 * The identity half of a spec, with the operational blocks removed.
 *
 * Line-based and deliberately conservative: a document that does not open with `---`
 * is returned untouched, and so is one whose frontmatter never closes. Guessing at
 * malformed YAML would risk deleting the identity it is supposed to preserve.
 */
export function stripOperationalBlocks(spec: string): string {
	const lines = spec.split(/\r?\n/);
	if (lines[0]?.trim() !== "---") return spec;

	const closing = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
	if (closing < 0) return spec;

	const kept: string[] = [];
	let dropping = false;

	for (let index = 0; index <= closing; index += 1) {
		const line = lines[index] as string;
		if (index > 0 && index < closing) {
			const topKey = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:/.exec(line);
			if (topKey) dropping = OPERATIONAL_KEYS.has(topKey[1] as string);
			if (dropping) continue;
		}
		kept.push(line);
	}

	for (let index = closing + 1; index < lines.length; index += 1) {
		kept.push(lines[index] as string);
	}

	return kept.join("\n");
}

/** A persona and a task, in the shape a host model is meant to read. */
export function renderApplyBlock(personaName: string, spec: string, task: string): string {
	return [
		`<persona name="${personaName}">`,
		"Follow the persona specification below for tone, values, character, and",
		"working style. Stay in character. Do not break role. Do not invent",
		"capabilities the spec does not declare.",
		"",
		spec,
		"</persona>",
		"",
		`<task>${task}</task>`,
	].join("\n");
}

/** The argument shapes, kept beside the tools that take them. */
export const cloudArgs = {
	search: {
		query: z.string().optional().describe("Free text to match against name and description."),
		category: z.string().optional().describe("Narrow to one registry category."),
		limit: z.number().int().positive().max(100).optional().describe("How many to return."),
	},
	fetch: { slug: z.string().describe("The persona's registry slug, e.g. `acme/watcher`.") },
	apply: {
		slug: z.string().describe("The persona's registry slug."),
		task: z.string().describe("What you want done while wearing that persona."),
	},
	evaluate: {
		slug: z.string().describe("The persona the response should be judged against."),
		response: z.string().describe("The text to judge."),
		role: z.string().optional().describe("The role the response was written in, when it matters."),
	},
} as const;
