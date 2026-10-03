/**
 * E168: a call to the model runs under our clock, not under Node's 300 seconds.
 *
 * Seen on 2026-10-03 with qwen3:4b on a laptop's CPU behind Ollama: no header came until the prompt was read, which took
 * longer than undici's default, and the call failed while the model worked. Waiting 300 seconds in a test proves
 * nothing quickly, so the clock is set short here through `PERSONAXIS_MODEL_HEADERS_TIMEOUT_MS` against a real HTTP
 * server that sends its first header late: a call that fails on THAT short clock is a call running under ours.
 */
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { requestToolCall } from "../src/tool-calling.js";

const LATE_MS = 1500;
let server: Server;
let endpoint = "";
const saved = process.env.PERSONAXIS_MODEL_HEADERS_TIMEOUT_MS;

beforeEach(async () => {
	server = createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			setTimeout(() => {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "late but whole" } }] }));
			}, LATE_MS);
		});
	});
	await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
	const address = server.address();
	endpoint = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/v1`;
});

afterEach(async () => {
	if (saved === undefined) delete process.env.PERSONAXIS_MODEL_HEADERS_TIMEOUT_MS;
	else process.env.PERSONAXIS_MODEL_HEADERS_TIMEOUT_MS = saved;
	server.closeAllConnections();
	await new Promise((ok) => server.close(ok));
});

const ask = () => requestToolCall({ endpoint, model: "m" }, [{ role: "user", content: "hi" }], []);

describe("the clock a call to the model runs under (E168)", () => {
	it("is ours: a first header later than our clock fails on our clock, not on Node's 300 seconds", async () => {
		process.env.PERSONAXIS_MODEL_HEADERS_TIMEOUT_MS = "500";
		const error = await ask().then(
			() => null,
			(e: unknown) => e as Error & { cause?: { code?: string } },
		);
		expect(error).not.toBeNull();
		expect(JSON.stringify({ message: error?.message, cause: error?.cause?.code })).toMatch(/UND_ERR_HEADERS_TIMEOUT|fetch failed/);
	}, 20_000);

	it("and a first header inside our clock is waited for, however late", async () => {
		process.env.PERSONAXIS_MODEL_HEADERS_TIMEOUT_MS = "5000";
		const reply = await ask();
		expect(reply.text).toBe("late but whole");
	}, 20_000);

	it("a declaration that is not a positive number is ignored, and the default still waits for a late header", async () => {
		for (const bad of ["0", "-5", "soon"]) {
			process.env.PERSONAXIS_MODEL_HEADERS_TIMEOUT_MS = bad;
			expect((await ask()).text, bad).toBe("late but whole");
		}
	}, 30_000);
});
