/**
 * E48: a hosted gateway that cuts a long silence, and a streamed answer that is never silent.
 *
 * Measured 2026-09-10 on the HuggingFace router: a whole 8192-token completion came back 504 with the model still
 * working, so the persona polish never finished. The router has had no credits since 2026-09-25 and NVIDIA's API does
 * not cut (5,383 tokens in 35 s), so the gateway is played here by a real HTTP server that answers 504 when the first
 * byte takes longer than its patience, and lets a stream through once it has started. The provider is the real one,
 * pointed at it through the same environment variables a user would set.
 */
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createLocalProvider } from "../src/providers/local.js";

/** How long the gateway waits for a first byte, and how long the "model" takes to write the whole answer. */
const PATIENCE_MS = 300;
const GENERATION_MS = 900;
const PARTS = ["The lighthouse ", "keeper's ", "game, ", "polished."];

let server: Server;
let endpoint = "";
let seen: Array<{ stream: boolean }> = [];
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
	seen = [];
	server = createServer((req, res) => {
		let raw = "";
		req.on("data", (c) => (raw += c));
		req.on("end", () => {
			const body = JSON.parse(raw || "{}") as { stream?: boolean };
			seen.push({ stream: body.stream === true });
			if (body.stream) {
				// A stream starts at once and keeps sending while the model writes.
				res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
				PARTS.forEach((part, i) => {
					setTimeout(() => {
						res.write(`data: ${JSON.stringify({ model: "gateway-model", choices: [{ delta: { content: part } }] })}\n\n`);
						if (i === PARTS.length - 1) {
							res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { completion_tokens: 9 } })}\n\n`);
							res.end("data: [DONE]\n\n");
						}
					}, ((i + 1) * GENERATION_MS) / PARTS.length);
				});
				return;
			}
			// A whole answer would only start after the model finished, which is past the gateway's patience.
			setTimeout(() => {
				res.writeHead(504, { "content-type": "text/html" });
				res.end("<html><body><h1>504 Gateway Time-out</h1></body></html>");
			}, PATIENCE_MS);
		});
	});
	await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
	const address = server.address();
	endpoint = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/v1`;
	for (const k of ["PERSONAXIS_ENDPOINT", "PERSONAXIS_MODEL", "PERSONAXIS_API_KEY"]) saved[k] = process.env[k];
	process.env.PERSONAXIS_ENDPOINT = endpoint;
	process.env.PERSONAXIS_MODEL = "gateway-model";
	delete process.env.PERSONAXIS_API_KEY;
});

afterEach(async () => {
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	await new Promise((ok) => server.close(ok));
});

describe("a long answer behind a gateway that cuts silence (E48)", () => {
	it("the provider asks for a stream and puts the answer back together", async () => {
		const provider = createLocalProvider({} as never);
		const result = await provider.run("polish this persona");

		expect(result.text).toBe(PARTS.join(""));
		expect(result.model).toBe("gateway-model");
		expect(seen.every((s) => s.stream)).toBe(true);
	}, 30_000);

	it("structured output comes back through the stream too, and is parsed as JSON", async () => {
		server.removeAllListeners("request");
		server.on("request", (req, res) => {
			let raw = "";
			req.on("data", (c) => (raw += c));
			req.on("end", () => {
				seen.push({ stream: (JSON.parse(raw) as { stream?: boolean }).stream === true });
				res.writeHead(200, { "content-type": "text/event-stream" });
				for (const part of ['{"name": ', '"Vega", ', '"traits": 3}']) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`);
				res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
				res.end("data: [DONE]\n\n");
			});
		});
		const provider = createLocalProvider({} as never);
		const result = await provider.runStructured!("extract", { type: "object" }, "persona");

		expect(result.json).toEqual({ name: "Vega", traits: 3 });
	});

	it("a server that ignores stream and answers whole is still read", async () => {
		server.removeAllListeners("request");
		server.on("request", (req, res) => {
			req.resume();
			req.on("end", () => {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ model: "whole", choices: [{ finish_reason: "stop", message: { content: "whole answer" } }] }));
			});
		});
		const result = await createLocalProvider({} as never).run("hi");

		expect(result.text).toBe("whole answer");
		expect(result.model).toBe("whole");
	});

	it("a stream that only reasons and stops at the cap still says why there is no answer", async () => {
		server.removeAllListeners("request");
		server.on("request", (req, res) => {
			req.resume();
			req.on("end", () => {
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "Thinking about the polish..." } }] })}\n\n`);
				res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] })}\n\n`);
				res.end("data: [DONE]\n\n");
			});
		});
		await expect(createLocalProvider({} as never).run("hi")).rejects.toThrow(/token limit.*thinking/s);
	});
});
