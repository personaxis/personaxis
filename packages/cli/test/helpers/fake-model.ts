/**
 * A model for tests that run the real CLI: an OpenAI-compatible endpoint on a local socket, plus a
 * way to run the CLI that does not block it.
 *
 * Since 2026-10-07 a persona answers, appraises and remembers through a model or not at all, so a
 * test of those paths needs a model. This one answers deterministically and stands in for the model
 * only: everything the runtime does with an answer (record it, persist a fact, inject memory into the
 * next prompt) is the real code. The CLI is run with `spawn`, never `spawnSync` or `execFileSync`,
 * because a synchronous child blocks this process's event loop and with it the server the child is
 * talking to. Every response closes its connection: a kept-alive socket to this server made the
 * child crash on exit on Windows (libuv `UV_HANDLE_CLOSING` assertion), which a real endpoint does not.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface FakeModel {
	/** The base URL to pass as PERSONAXIS_ENDPOINT. */
	endpoint: string;
	/** Every request body received, in order. */
	requests: Array<Record<string, unknown>>;
	close(): Promise<void>;
}

type Message = { role: string; content: unknown };

const text = (m: Message | undefined): string => (typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? ""));

/** A self-introduction in the last user message, the way a model would read one. */
function introducedName(messages: Message[]): string | undefined {
	const last = [...messages].reverse().find((m) => m.role === "user");
	return /(?:me llamo|my name is|i am|soy)\s+([A-ZÁÉÍÓÚ][\p{L}-]+)/iu.exec(text(last))?.[1];
}

/** A name the runtime put in the prompt as a known fact. */
function knownName(messages: Message[]): string | undefined {
	return /interlocutor(?:\.name:\s*|: name = )([\p{L}-]+)/u.exec(messages.map(text).join("\n"))?.[1];
}

/**
 * The Genesis stage answers of a real run (command-a-03-2025, 2026-10-07, brief "A terse code reviewer
 * that never softens findings"), each the answer the code accepted. A test with other sources gets the same
 * answers, with every quote its prompt does not contain turned into an inference, because a quote the
 * sources lack is the first thing `checkStage` rejects.
 */
const RECORDED = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "genesis-terse-reviewer.json"), "utf8")) as {
	answers: Record<string, { reasoning: string; layer: unknown; provenance: Array<{ path: string; source?: string; quote?: string; inferred?: string }> }>;
	/** The PERSONA.md the same model wrote for that persona, accepted by the faithfulness check. */
	document: string;
};

function genesisAnswer(body: Record<string, unknown>, prompt: string): string | undefined {
	const name = (body.response_format as { json_schema?: { name?: string } } | undefined)?.json_schema?.name;
	const recorded = name?.startsWith("persona_") ? RECORDED.answers[name.slice("persona_".length)] : undefined;
	if (!recorded) return undefined;
	// Only the sources count: later prompts also carry what earlier stages decided, which repeats the brief.
	const sources = [...prompt.matchAll(/<source id="([^"]+)"[^>]*>\n([\s\S]*?)\n<\/source>/g)];
	const cited = (p: { source?: string; quote?: string }) => sources.some(([, id, body]) => id === p.source && body?.includes(p.quote ?? ""));
	// The coherence reading lists rules with their quotes: a rule whose words these sources lack is not one of theirs.
	const rules = (recorded as { rules?: Array<{ source?: string; quote?: string }> }).rules;
	if (rules) return JSON.stringify({ ...recorded, rules: rules.filter(cited) });
	const provenance = recorded.provenance.map((p) =>
		p.quote && !cited(p) ? { path: p.path, inferred: "recorded answer; the quote is not in these sources" } : p,
	);
	return JSON.stringify({ ...recorded, provenance });
}

export interface FakeModelOptions {
	/** What the model answers when asked to write a PERSONA.md; the recorded document by default. */
	document?: string;
}

function answerFor(body: Record<string, unknown>, options: FakeModelOptions): string {
	const messages = (body.messages as Message[] | undefined) ?? [];
	const genesis = genesisAnswer(body, messages.map(text).join("\n"));
	if (genesis) return genesis;
	if (text(messages[messages.length - 1]).startsWith("You write the compiled document for")) return options.document ?? RECORDED.document;
	if (body.response_format || /appraise|appraisal/i.test(text(messages[0]))) {
		const name = introducedName(messages);
		return JSON.stringify({
			appraisal: "noted",
			mutations: [],
			memories: [],
			preferences: name ? [{ key: "interlocutor.name", value: name, rationale: "self-introduction" }] : [],
			confidence: 0.9,
		});
	}
	const name = knownName(messages);
	return name ? `Hello again, ${name}.` : "Hello.";
}

export function startFakeModel(options: FakeModelOptions = {}): Promise<FakeModel> {
	const requests: Array<Record<string, unknown>> = [];
	const server: Server = createServer((req, res) => {
		let raw = "";
		req.on("data", (chunk) => (raw += chunk));
		req.on("end", () => {
			const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
			requests.push(body);
			const content = answerFor(body, options);
			if (body.stream) {
				res.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
				res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
				res.end("data: [DONE]\n\n");
				return;
			}
			res.writeHead(200, { "content-type": "application/json", connection: "close" });
			res.end(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
		});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () =>
			resolve({
				endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
				requests,
				close: () => new Promise((done) => server.close(() => done())),
			}),
		);
	});
}

export interface CliRun {
	code: number;
	stdout: string;
	stderr: string;
	out: string;
}

/** Run the built CLI without blocking the event loop, feeding `input` on stdin when given. */
export function runCli(cli: string, args: string[], opts: { env?: Record<string, string>; input?: string; cwd?: string } = {}): Promise<CliRun> {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [cli, ...args], {
			cwd: opts.cwd,
			env: { ...process.env, FORCE_COLOR: "0", PERSONAXIS_NO_UPDATE_CHECK: "1", ...opts.env },
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => (stdout += d));
		child.stderr.on("data", (d) => (stderr += d));
		child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr, out: stdout + stderr }));
		child.stdin.end(opts.input ?? "");
	});
}

/** The environment that points a child CLI at the fake model. */
export function modelEnv(model: FakeModel): Record<string, string> {
	return { PERSONAXIS_ENDPOINT: model.endpoint, PERSONAXIS_MODEL: "fake", PERSONAXIS_API_KEY: "test" };
}
