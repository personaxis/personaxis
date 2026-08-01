/**
 * One HTTP client for the workspace.
 *
 * There used to be a second one inside `runtime.ts` with its own base URL, its
 * own error shaping and its own idea of which credential to read. Two clients
 * mean two behaviours the day one is fixed, so `runtime` now calls this and the
 * duplicate is gone.
 *
 * Errors come back as a thrown `WorkspaceError` rather than a process exit.
 * The exit belongs to the command: a library that calls `process.exit` cannot
 * be used from the REPL, from a daemon loop, or from a test.
 */

import { version } from "../generated/assets.js";
import { REGISTRY_UA_PREFIX } from "../registry-config.js";
import { loadDevice } from "./token-store.js";
import { appUrl } from "./urls.js";

export class WorkspaceError extends Error {
	readonly status: number;
	readonly code: string;

	constructor(message: string, status: number, code = "ERROR") {
		super(message);
		this.name = "WorkspaceError";
		this.status = status;
		this.code = code;
	}
}

export interface WorkspaceClientOptions {
	baseUrl?: string;
	token?: string;
	fetch?: typeof fetch;
	env?: NodeJS.ProcessEnv;
}

/**
 * Resolves the credential the way the rest of the CLI does: the explicit one
 * wins, then a workspace API key from the environment, then the device token
 * this machine was linked with.
 *
 * The device token comes last because it is the least specific: a person who
 * exported `PERSONAXIS_API_KEY` for one command meant that command to use it.
 */
export function resolveToken(options: WorkspaceClientOptions = {}): string | null {
	if (options.token) return options.token;
	const env = options.env ?? process.env;
	if (env.PERSONAXIS_API_KEY) return env.PERSONAXIS_API_KEY;
	return loadDevice()?.token ?? null;
}

export class WorkspaceClient {
	private readonly baseUrl: string;
	private readonly doFetch: typeof fetch;
	private readonly options: WorkspaceClientOptions;

	constructor(options: WorkspaceClientOptions = {}) {
		this.options = options;
		this.baseUrl = options.baseUrl ?? appUrl(options.env ?? process.env);
		this.doFetch = options.fetch ?? ((...args) => fetch(...args));
	}

	get url(): string {
		return this.baseUrl;
	}

	async request<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
		const token = resolveToken(this.options);
		if (!token) {
			throw new WorkspaceError(
				"This machine is not linked to a workspace. Run `personaxis connect`, or set PERSONAXIS_API_KEY.",
				401,
				"NO_CREDENTIAL",
			);
		}

		const response = await this.doFetch(`${this.baseUrl}${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${token}`,
				"User-Agent": `${REGISTRY_UA_PREFIX}${version}`,
				Accept: "application/json",
				...(body != null ? { "Content-Type": "application/json" } : {}),
			},
			body: body != null ? JSON.stringify(body) : undefined,
		});

		if (!response.ok) {
			let message = `${method} ${path} failed with ${response.status}`;
			let code = "ERROR";
			try {
				const parsed = (await response.json()) as {
					error?: { code?: string; message?: string } | string;
				};
				if (typeof parsed.error === "string") {
					message = parsed.error;
				} else if (parsed.error?.message) {
					message = parsed.error.message;
					code = parsed.error.code ?? code;
				}
			} catch {
				/* the status alone is the message */
			}
			throw new WorkspaceError(message, response.status, code);
		}

		if (response.status === 204) return undefined as T;
		return (await response.json()) as T;
	}

	/** Who this credential belongs to. Used by `connect status`. */
	whoami(): Promise<{
		machine_id?: string;
		machine_name?: string;
		organization_id: string;
		organization_name: string;
		scopes: string[];
	}> {
		return this.request("GET", "/api/v1/me");
	}

	/** Revokes this machine's token server-side. */
	revokeMachine(machineId: string): Promise<void> {
		return this.request("DELETE", `/api/v1/machines/${encodeURIComponent(machineId)}/token`);
	}
}
