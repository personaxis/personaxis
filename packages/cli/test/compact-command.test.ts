/**
 * `/compact`, the compaction a person asks for, driven end to end as they type it.
 *
 * ## Why this is not the sibling of `conversation-compaction.test.ts`
 *
 * That one injects a scripted model into `maybeAutoCompact`, because the automatic door is reached from
 * inside a turn and there is no other way in. This one takes the harder and more honest road: it stands up an
 * HTTP server on `127.0.0.1` and lets the command resolve its own model through `llmConfig` and
 * `resolveModel`, exactly as it does in front of a person. `isLocalEndpoint` allows a local endpoint with no
 * key, and `PERSONAXIS_ENDPOINT`/`PERSONAXIS_MODEL` are the highest-precedence layer, so no seam has to be
 * added to the product for a test to be able to look at it.
 *
 * So what runs here is the whole thing: `runCommand("/compact")`, the config resolution, a real request over
 * a socket, the summarising, the count against the session, and what is printed back.
 *
 * ## The defect this pins
 *
 * Until 2026-09-18 the asked-for compaction never called `meter.compacted(...)`, while the automatic one did.
 * A session where somebody compacted by hand reported ZERO compactions and zero tokens freed under
 * `/context`: the work happened and the session did not know. Both doors now go through one shared path, and
 * the third case below is what keeps them from drifting apart again.
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ContextMeter } from "@personaxis/core";
import { runCommand } from "../src/repl/commands.js";
import { makeCtx } from "../src/repl/session.js";
import { writeStarterPersona } from "../src/starter.js";

/** The window this works against. Small, so an ordinary conversation fills it. */
const WINDOW = 1_000;

let dir: string;
let server: Server;
let asked: number;
const saved: Record<string, string | undefined> = {};

/** An OpenAI-shaped endpoint that answers every route, so the command talks to a real socket. */
function summariserOn(): Promise<string> {
	asked = 0;
	server = createServer((_req, res) => {
		asked += 1;
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ choices: [{ message: { content: "earlier: the game design and the fixes agreed so far" } }] }));
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`));
	});
}

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "pxs-compact-cmd-"));
	for (const key of ["PERSONAXIS_HOME", "PERSONAXIS_ENDPOINT", "PERSONAXIS_MODEL", "PERSONAXIS_API_KEY"]) saved[key] = process.env[key];
	process.env.PERSONAXIS_HOME = join(dir, "home");
	delete process.env.PERSONAXIS_API_KEY;
	process.env.PERSONAXIS_ENDPOINT = await summariserOn();
	process.env.PERSONAXIS_MODEL = "m";
});

afterEach(async () => {
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await new Promise((resolve) => server.close(resolve));
	rmSync(dir, { recursive: true, force: true });
});

/** What a person and a persona said, back and forth, all of it in ONE context. */
function conversing(turns: number): { role: string; content: string }[] {
	const said = [
		["user", "I want a small arcade game about a cat crossing a road"],
		["assistant", "Here is the design: one road, three lanes, a timer"],
		["user", "the cat moves too slowly, fix that"],
		["assistant", "Raised the step to 24 pixels and shortened the hop"],
	];
	return Array.from({ length: turns }, (_, index) => {
		const [role, content] = said[index % said.length]!;
		return { role: role!, content: `${content} (${index})` };
	});
}

function sessionOf(fraction: number, turns: number) {
	const meter = new ContextMeter(WINDOW);
	const ctx = makeCtx(writeStarterPersona(dir, "Clio"), meter);
	ctx.conversation = conversing(turns) as never;
	meter.used = Math.round(WINDOW * fraction);
	const shown: string[] = [];
	ctx.out = (text: string) => void shown.push(text);
	return { ctx, meter, shown };
}

describe("/compact, the compaction a person asks for", () => {
	it("summarises the older turns whenever it is asked, even with room to spare, and says what it freed", async () => {
		// Half full: nothing would fire on its own here, which is the whole point of asking.
		const { ctx, meter, shown } = sessionOf(0.5, 30);
		const before = meter.used;

		await runCommand("/compact", ctx);

		expect(asked).toBe(1); // it really went out over the socket
		expect(ctx.conversation.length).toBeLessThan(30);
		expect(JSON.stringify(ctx.conversation)).toContain("(29)"); // the most recent turn survives verbatim
		expect(meter.used).toBeLessThan(before);
		expect(shown.join("\n")).toContain("compacted");
	});

	it("counts against the session, because a compaction /context does not know about is one that was not reported", async () => {
		const { ctx, meter } = sessionOf(0.5, 30);

		await runCommand("/compact", ctx);

		// This is the defect: until the two doors shared one path, only the automatic one counted.
		const report = meter.compactionReport();
		expect(report.count).toBe(1);
		expect(report.tokensFreed).toBeGreaterThan(0);
	});

	it("leaves the conversation alone and says so when no model is configured", async () => {
		delete process.env.PERSONAXIS_ENDPOINT;
		delete process.env.PERSONAXIS_MODEL;
		const { ctx, shown } = sessionOf(0.5, 30);
		const before = [...ctx.conversation];

		await runCommand("/compact", ctx);

		expect(asked).toBe(0);
		expect(ctx.conversation).toEqual(before);
		expect(shown.join("\n")).toContain("needs a model");
	});
});
