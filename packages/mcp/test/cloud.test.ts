/**
 * R9: the four hosted-registry tools, in the one server.
 *
 * What these pin is the thing the ADR of 2026-08-30 says will break if it is missed:
 * the old client THREW when `PERSONAXIS_API_KEY` was absent, at startup, and in a
 * single server that kills the process for somebody who only wants the sixteen local
 * tools. The account half degrades; the machine half never notices.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildServer } from "../src/index.js";
import {
	cloudConfig,
	renderApplyBlock,
	stripOperationalBlocks,
	NO_KEY_MESSAGE,
} from "../src/cloud.js";

const CLOUD_TOOLS = ["personas_search", "personas_fetch", "personas_apply", "runtime_evaluate"];

let client: Client;
let savedKey: string | undefined;

beforeEach(async () => {
	savedKey = process.env.PERSONAXIS_API_KEY;
	delete process.env.PERSONAXIS_API_KEY;

	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	const server = buildServer({ hosted: true });
	await server.connect(serverSide);
	client = new Client({ name: "test", version: "1.0.0" });
	await client.connect(clientSide);
});

afterEach(async () => {
	await client.close();
	if (savedKey === undefined) delete process.env.PERSONAXIS_API_KEY;
	else process.env.PERSONAXIS_API_KEY = savedKey;
});

describe("not in this version (L14)", () => {
	it("a default server mounts none of the four, because the hosted registry is not live", async () => {
		const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
		await buildServer().connect(serverSide);
		const plain = new Client({ name: "test", version: "1.0.0" });
		await plain.connect(clientSide);
		const names = (await plain.listTools()).tools.map((tool) => tool.name);
		await plain.close();

		for (const tool of CLOUD_TOOLS) expect(names).not.toContain(tool);
		expect(names).toHaveLength(16);
	});
});

describe("one server, twenty tools, when the hosted half is offered", () => {
	it("offers the four hosted ones beside the local ones", async () => {
		const names = (await client.listTools()).tools.map((tool) => tool.name);

		for (const tool of CLOUD_TOOLS) expect(names).toContain(tool);
		// The local half, still there: this is a move, not a replacement.
		expect(names).toContain("persona_compiled");
		expect(names).toContain("persona_audit");
	});

	it("offers them even with no account key, rather than hiding them", async () => {
		// A tool that is absent for an unknown reason and a tool that does not exist
		// look identical to a model, and somebody debugging "why can't it search the
		// registry" would have nothing to read.
		const names = (await client.listTools()).tools.map((tool) => tool.name);

		expect(cloudConfig({} as NodeJS.ProcessEnv)).toBe(null);
		for (const tool of CLOUD_TOOLS) expect(names).toContain(tool);
	});
});

describe("without an account key", () => {
	it("says where to get one instead of failing the call", async () => {
		const said = await client.callTool({ name: "personas_search", arguments: { query: "x" } });
		const text = JSON.stringify(said.content);

		expect(text).toContain("PERSONAXIS_API_KEY");
		expect(text).toContain("personaxis.com/settings");
	});

	it("says the same for each of the four, and none of them throws", async () => {
		for (const name of CLOUD_TOOLS) {
			const args =
				name === "personas_search"
					? { query: "x" }
					: name === "runtime_evaluate"
						? { slug: "a/b", response: "hello" }
						: name === "personas_apply"
							? { slug: "a/b", task: "do it" }
							: { slug: "a/b" };

			const said = await client.callTool({ name, arguments: args });

			expect(JSON.stringify(said.content), name).toContain("needs an account key");
		}
	});

	it("leaves every local tool working, which is the whole point of degrading", async () => {
		// The failure the ADR names: the old client threw at STARTUP, so a missing key
		// took the sixteen tools that need no account down with it.
		//
		// The persona path is inside a temp directory, and that is not cosmetic: the
		// engine writes a `presence/` file BESIDE whatever persona it is asked about,
		// so a relative name here made the server drop session files into the package
		// itself, and three of them reached a commit before this was noticed.
		const said = await client.callTool({
			name: "persona_compiled",
			arguments: { persona: join(mkdtempSync(join(tmpdir(), "pxs-mcp-cloud-")), "nope.md") },
		});

		// It fails because that persona does not exist, which is a different failure
		// from the server never having started.
		expect(JSON.stringify(said.content)).not.toContain("PERSONAXIS_API_KEY");
	});
});

describe("reading the account key", () => {
	it("is absent when the variable is, and that is a value rather than a throw", () => {
		expect(cloudConfig({} as NodeJS.ProcessEnv)).toBe(null);
	});

	it("takes the hosted URL by default and lets it be pointed elsewhere", () => {
		expect(cloudConfig({ PERSONAXIS_API_KEY: "k" } as NodeJS.ProcessEnv)?.baseUrl).toBe(
			"https://personaxis.com",
		);
		expect(
			cloudConfig({ PERSONAXIS_API_KEY: "k", PERSONAXIS_BASE_URL: "http://local/" } as NodeJS.ProcessEnv)
				?.baseUrl,
		).toBe("http://local");
	});
});

describe("what a persona is handed to a model as", () => {
	it("drops the operational blocks and keeps the identity", () => {
		// Pasting assertions and evaluation policy into a system prompt hands the model
		// the test it is about to be marked against.
		const spec = [
			"---",
			"identity: { display_name: T }",
			"assertions:",
			"  - id: a1",
			"    name: never swears",
			"runtime: { sandbox: read-only }",
			"character: { tone: dry }",
			"---",
			"The body stays.",
		].join("\n");

		const kept = stripOperationalBlocks(spec);

		expect(kept).toContain("identity");
		expect(kept).toContain("character");
		expect(kept).toContain("The body stays.");
		expect(kept).not.toContain("assertions");
		expect(kept).not.toContain("never swears");
		expect(kept).not.toContain("sandbox");
	});

	it("returns a document it cannot parse untouched, rather than guessing", () => {
		// Guessing at malformed YAML risks deleting the identity this exists to keep.
		expect(stripOperationalBlocks("no frontmatter here")).toBe("no frontmatter here");
		expect(stripOperationalBlocks("---\nassertions: x\nnever closed")).toBe(
			"---\nassertions: x\nnever closed",
		);
	});

	it("wraps the persona around the task, with the task last", () => {
		const block = renderApplyBlock("Clio", "be dry", "summarise the log");

		expect(block).toContain('<persona name="Clio">');
		expect(block).toContain("be dry");
		expect(block.indexOf("<task>")).toBeGreaterThan(block.indexOf("</persona>"));
	});

	it("says where to get a key in one place, so four tools cannot drift apart", () => {
		expect(NO_KEY_MESSAGE).toContain("PERSONAXIS_API_KEY");
	});
});

describe("the persona resource, which came across with the tools", () => {
	it("is offered as a template a host can browse", async () => {
		// A resource is a different act from a tool: a host like Claude Desktop shows
		// these in a panel a PERSON opens, rather than a model deciding to call
		// something. Leaving it behind would have been a capability disappearing
		// quietly inside what was announced as a move.
		const templates = await client.listResourceTemplates();

		expect(templates.resourceTemplates.map((one) => one.uriTemplate)).toContain(
			"personaxis://personas/{slug}",
		);
	});

	it("says where to get a key rather than failing, like the four beside it", async () => {
		const read = await client.readResource({ uri: "personaxis://personas/acme%2Fwatcher" });

		expect(JSON.stringify(read.contents)).toContain("PERSONAXIS_API_KEY");
	});
});
