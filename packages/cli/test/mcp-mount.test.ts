/**
 * Mounting somebody else's tools, against a real MCP server.
 *
 * In memory rather than over stdio, and that is not a shortcut: the server here is the
 * SDK's own `McpServer` speaking the real protocol over the SDK's in-memory transport,
 * so the handshake, `tools/list` and `tools/call` are the genuine ones. What is skipped
 * is starting a process, which would make this a test of the operator's PATH.
 *
 * The thing worth pinning is not that a JSON-RPC call works. It is what happens to the
 * tools a server advertises once they are in our catalogue: that they arrive prefixed
 * and cannot shadow a built-in, that they are gated rather than trusted, that a server
 * which will not start costs its own tools and nothing else, and that a failing call
 * comes back as a result the model can react to rather than as a throw that ends a run
 * somebody was in the middle of.
 *
 * A transport pair is consumed by the connection it serves, so each test builds its
 * own. Sharing one would not fail; it would HANG, which is the worst way for a suite
 * to break.
 */

import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { mountAll, mountServer, textOf, MAX_RESULT } from "../src/mcp/mount.js";
import { noExecution } from "@personaxis/core";

/** E32: the third argument is WHERE the action happens. A mounted MCP tool talks to
 * its server, not to this machine, so a port that refuses everything is the truthful
 * stub and the call says so. */
const INERT = noExecution("an MCP tool acts through its server");


type Result = { content: Array<{ type: string; text?: string }> };

/** A live server offering these tools, and the client end of the wire to it. */
async function serverOffering(
	tools: Array<{ name: string; run: (args: { text?: string }) => Result }>,
) {
	const server = new McpServer({ name: "test-server", version: "1.0.0" });
	for (const tool of tools) {
		server.registerTool(
			tool.name,
			{ description: `the ${tool.name} tool`, inputSchema: { text: z.string().optional() } },
			async (args: { text?: string }) => tool.run(args) as never,
		);
	}

	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await server.connect(serverSide);
	return clientSide;
}

const said = (body: string): Result => ({ content: [{ type: "text", text: body }] });

/** The two tools most of these use: one that echoes, one that shadows a built-in. */
async function twoTools() {
	return serverOffering([
		{ name: "search", run: (args) => said(`found: ${args.text ?? ""}`) },
		{ name: "write_file", run: () => said("theirs, not ours") },
	]);
}

describe("a server's tools in our catalogue", () => {
	it("arrive under the server's name, so they cannot shadow a built-in", async () => {
		// A server advertising `write_file` must not become the engine's file writer.
		// The model chooses by name, so a collision is not a naming inconvenience: it is
		// somebody else's code running where the operator expected ours.
		const transport = await twoTools();
		const mounted = await mountServer("github", { command: "unused" }, { transportFor: () => transport });

		expect(mounted.tools.map((tool) => tool.name).sort()).toEqual([
			"github:search",
			"github:write_file",
		]);
		expect(mounted.tools.map((tool) => tool.name)).not.toContain("write_file");
	});

	it("call through to the server and bring its answer back", async () => {
		const transport = await twoTools();
		const mounted = await mountServer("tools", { command: "unused" }, { transportFor: () => transport });
		const search = mounted.tools.find((tool) => tool.name === "tools:search");

		expect(await search?.execute({ text: "hello" }, {} as never, INERT)).toBe("found: hello");
	});

	it("hand back an error as a result when the server has gone away", async () => {
		// A server dies mid-session, and it is somebody else's program so it will. The
		// model gets a step it can react to, which is a tool result; a throw would end
		// a run in the middle of something a person asked for.
		//
		// This control did not exist when the code was written, and removing the catch
		// left every other test green. Found by breaking it on purpose.
		const transport = await twoTools();
		const mounted = await mountServer("tools", { command: "unused" }, { transportFor: () => transport });
		const search = mounted.tools.find((tool) => tool.name === "tools:search");
		await mounted.close();

		const answer = await search?.execute({ text: "hello" }, {} as never, INERT);
		expect(answer).toContain("error calling tools:search");
	});

	it("keep the description the server gave, because that is what the model reads", async () => {
		const transport = await twoTools();
		const mounted = await mountServer("tools", { command: "unused" }, { transportFor: () => transport });

		expect(mounted.tools.find((tool) => tool.name === "tools:search")?.description).toContain(
			"the search tool",
		);
	});
});

describe("what a mounted tool is allowed to do", () => {
	it("is gated to ask outside full access, because it runs code somewhere else", async () => {
		// The posture `mcp-adapter.ts` chose, checked here because it is only true in
		// production once something actually mounts a server.
		const transport = await twoTools();
		const mounted = await mountServer("tools", { command: "unused" }, { transportFor: () => transport });
		const search = mounted.tools.find((tool) => tool.name === "tools:search");

		expect(search?.gate({}, { sandbox: "workspace-write" } as never).decision).toBe("ask");
		expect(search?.gate({}, { sandbox: "danger-full-access" } as never).decision).toBe("allow");
	});

	it("is never concurrency-safe unless the server said it was both read-only and idempotent", async () => {
		// Concurrency across a server we did not write is unknown, and the safe reading
		// of unknown is to serialise.
		const transport = await twoTools();
		const mounted = await mountServer("tools", { command: "unused" }, { transportFor: () => transport });

		expect(mounted.tools.every((tool) => tool.isConcurrencySafe !== true)).toBe(true);
	});
});

describe("a server that does not come up", () => {
	it("costs its own tools and nothing else", async () => {
		// The failure an operator actually hits: a server registered weeks ago whose
		// command is no longer installed. A persona that refused to start because of it
		// would be unusable, and nothing would say which of five servers did it.
		const working = await serverOffering([{ name: "search", run: () => said("found") }]);

		const mounted = await mountAll(
			{ broken: { command: "unused" }, good: { command: "unused" } },
			{
				transportFor: (name) => {
					if (name === "broken") throw new Error("spawn ENOENT");
					return working;
				},
			},
		);

		expect(mounted.failures.map((failure) => failure.name)).toEqual(["broken"]);
		expect(mounted.failures[0]?.reason).toContain("ENOENT");
		expect(mounted.tools.map((tool) => tool.name)).toEqual(["good:search"]);
	});

	it("names the server, because a reason on its own does not say which one", async () => {
		const mounted = await mountAll(
			{ first: { command: "unused" } },
			{
				transportFor: () => {
					throw new Error("nope");
				},
			},
		);

		expect(mounted.failures).toEqual([{ name: "first", reason: "nope" }]);
	});

	it("mounts nothing, quietly, when the operator registered nothing", async () => {
		// The ordinary case, and it has to cost nothing: an empty list connects to no
		// server, so a persona with no MCP config pays nothing at startup.
		const mounted = await mountAll({});

		expect(mounted.tools).toEqual([]);
		expect(mounted.failures).toEqual([]);
	});
});

describe("what comes back from a call", () => {
	it("renders text parts, and says what a part it could not render was", () => {
		// A model reached through a text protocol cannot act on an image. Saying so
		// leaves it reasoning about a result whose shape it knows; dropping the part
		// silently does not.
		expect(textOf({ content: [{ type: "text", text: "hello" }] })).toBe("hello");
		expect(textOf({ content: [{ type: "image", mimeType: "image/png" }] })).toBe("[image image/png]");
	});

	it("marks the server's own error rather than throwing it", () => {
		// A tool that failed is a step the model can react to. A throw is a run that
		// ends, in the middle of something a person asked for.
		expect(textOf({ content: [{ type: "text", text: "no such repo" }], isError: true })).toContain(
			"error from the MCP server",
		);
	});

	it("bounds the size, because context is the budget being spent", () => {
		const rendered = textOf({ content: [{ type: "text", text: "x".repeat(MAX_RESULT * 2) }] });

		expect(rendered.length).toBeLessThan(MAX_RESULT + 100);
		expect(rendered).toContain("[truncated]");
	});

	it("survives a result with no content at all", () => {
		// Permitted by the protocol, and returned by real servers for a tool whose whole
		// job is a side effect.
		expect(textOf({})).toBe("");
	});
});
