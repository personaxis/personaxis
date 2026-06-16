// CLI commands that talk to the Personaxis REST API v1 using a bearer
// pxis_<prefix>_<secret> token.
//
// Subcommands:
//   personaxis runtime start <slug>              - open a session
//   personaxis runtime trace <session> <msg>     - append a trace
//   personaxis runtime end <session>             - end a session
//   personaxis runtime evaluate <slug> <file>    - one-shot CI gate

import chalk from "chalk";
import { Command } from "commander";
import { readFileSync } from "fs";
import { resolve } from "path";

const DEFAULT_BASE_URL = "https://personaxis.com";

function getApiKey(): string {
	const key = process.env.PERSONAXIS_API_KEY;
	if (!key) {
		console.error(chalk.red("PERSONAXIS_API_KEY is not set."));
		console.error(
			chalk.dim("Create a key in the dashboard: https://personaxis.com/[org]/settings/api-keys"),
		);
		process.exit(1);
	}
	return key;
}

function getBaseUrl(): string {
	return (process.env.PERSONAXIS_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
}

async function apiCall<T>(
	method: "GET" | "POST",
	path: string,
	body?: unknown,
): Promise<T> {
	const key = getApiKey();
	const base = getBaseUrl();
	const res = await fetch(`${base}${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${key}`,
			"User-Agent": "personaxis-cli/0.4.0",
			Accept: "application/json",
			...(body != null ? { "Content-Type": "application/json" } : {}),
		},
		body: body != null ? JSON.stringify(body) : undefined,
	});
	if (!res.ok) {
		let msg = `${method} ${path} failed with ${res.status}`;
		try {
			const j = (await res.json()) as { error?: { code?: string; message?: string } };
			if (j.error?.message) msg = `${j.error.code ?? "ERROR"}: ${j.error.message}`;
		} catch {
			/* keep default */
		}
		console.error(chalk.red(msg));
		process.exit(1);
	}
	return (await res.json()) as T;
}

const startCmd = new Command("start")
	.description("Open a runtime session against a persona-version")
	.argument("<slug>", "Persona slug")
	.option("--semver <semver>", "Pin to a specific semver (defaults to latest)")
	.option("--consumer-type <type>", "agent | human | mcp_client", "agent")
	.option("--encrypted", "Enable AES-256-GCM encryption for trace content")
	.action(async (slug: string, opts: { semver?: string; consumerType?: string; encrypted?: boolean }) => {
		const res = await apiCall<{ sessionId: string; versionSemver: string; startedAt: string }>(
			"POST",
			"/api/v1/runtime/sessions",
			{
				personaSlug: slug,
				semver: opts.semver,
				consumerType: opts.consumerType ?? "agent",
				contentEncrypted: opts.encrypted ?? false,
			},
		);
		console.log(chalk.green("session started"));
		console.log(chalk.dim("id:     "), res.sessionId);
		console.log(chalk.dim("version:"), res.versionSemver);
		console.log(chalk.dim("started:"), res.startedAt);
	});

const traceCmd = new Command("trace")
	.description("Append a trace to an open session")
	.argument("<sessionId>")
	.argument("<role>", "system | user | assistant | tool")
	.argument("<content>", "Plaintext content")
	.option("--latency <ms>", "Latency in milliseconds")
	.action(async (sessionId: string, role: string, content: string, opts: { latency?: string }) => {
		const res = await apiCall<{ traceId: string; index: number }>(
			"POST",
			`/api/v1/runtime/sessions/${encodeURIComponent(sessionId)}/traces`,
			{
				role,
				content,
				latencyMs: opts.latency ? Number(opts.latency) : undefined,
			},
		);
		console.log(chalk.green("trace appended"));
		console.log(chalk.dim("traceId:"), res.traceId);
		console.log(chalk.dim("index:  "), res.index);
	});

const endCmd = new Command("end")
	.description("Mark a session as ended")
	.argument("<sessionId>")
	.action(async (sessionId: string) => {
		const res = await apiCall<{ sessionId: string; alreadyEnded: boolean }>(
			"POST",
			`/api/v1/runtime/sessions/${encodeURIComponent(sessionId)}/end`,
		);
		console.log(
			chalk.green(res.alreadyEnded ? "session was already ended" : "session ended"),
		);
		console.log(chalk.dim("id:"), res.sessionId);
	});

const evaluateCmd = new Command("evaluate")
	.description("Run a persona's assertions against a candidate response (CI gate)")
	.argument("<slug>", "Persona slug")
	.argument("<file>", "Path to a file containing the candidate response, or '-' for stdin")
	.option("--semver <semver>")
	.option("--role <role>", "assistant | user | system | tool", "assistant")
	.action(async (slug: string, file: string, opts: { semver?: string; role?: string }) => {
		let response: string;
		if (file === "-") {
			response = await readStdin();
		} else {
			response = readFileSync(resolve(file), "utf8");
		}
		const res = await apiCall<{
			versionSemver: string;
			passed: number;
			total: number;
			results: Array<{
				name: string;
				layer: string;
				severity: string;
				passed: boolean;
				score: number | null;
				evidence: string;
			}>;
		}>("POST", "/api/v1/runtime/evaluate", {
			personaSlug: slug,
			semver: opts.semver,
			response,
			role: opts.role ?? "assistant",
		});

		console.log(chalk.dim("version:"), res.versionSemver);
		console.log();
		for (const r of res.results) {
			const tick = r.passed ? chalk.green("✓") : chalk.red("✗");
			const layer = chalk.dim(`[${r.layer}/${r.severity}]`);
			const score = r.score != null ? chalk.dim(`(${r.score.toFixed(2)})`) : "";
			console.log(`${tick} ${layer} ${r.name} ${score}`);
			if (!r.passed && r.evidence) console.log(chalk.dim(`   ${r.evidence}`));
		}
		console.log();
		const summary = `${res.passed}/${res.total} passed`;
		console.log(res.passed === res.total ? chalk.green(summary) : chalk.red(summary));

		// Exit non-zero so CI can fail the pipeline.
		if (res.passed < res.total) process.exit(2);
	});

function readStdin(): Promise<string> {
	return new Promise((resolveFn) => {
		let data = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => {
			data += chunk;
		});
		process.stdin.on("end", () => resolveFn(data));
	});
}

export const runtimeCommand = new Command("runtime")
	.description("Open runtime sessions, append traces, evaluate against assertions (REST v1)")
	.addCommand(startCmd)
	.addCommand(traceCmd)
	.addCommand(endCmd)
	.addCommand(evaluateCmd);
