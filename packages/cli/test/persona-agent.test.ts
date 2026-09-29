/**
 * A persona driven from somebody else's editor.
 *
 * Both ends are real, over two in-memory pipes: our served agent on one side and a
 * real client connection on the other, both built through `@personaxis/protocol`,
 * so every assertion here has crossed the wire and been encoded by the vendor's own
 * framing. What is faked is the persona, because what is under test is the protocol
 * surface: a model and a key would make these tests about a model and a key.
 *
 * The interesting half is the refusals. A persona installed in an editor we do not
 * control has to keep its envelope, and the ways that quietly stops being true are
 * an unreachable client, an answer nobody can read, and a session that never existed.
 */

import { PassThrough } from "node:stream";

import {
	ACP_PROTOCOL_VERSION,
	acpOverStdio,
	serveAcpOverStdio,
	type AcpServedClient,
} from "@personaxis/protocol";
import { describe, expect, it } from "vitest";

import { personaAgent, type PersonaSession, type TurnHooks } from "../src/workspace/persona-agent.js";

/** What the fake persona should do when it is asked for a turn. */
interface Script {
	readonly says?: readonly string[];
	readonly calls?: readonly { id: string; tool: string; ok?: boolean }[];
	/** Asks the client to permit this before answering. */
	readonly asks?: { id: string; tool: string; reason: string };
	readonly stopReason?: string;
	/** No persona lives in the directory. */
	readonly nowhere?: boolean;
	/** The person on the other end closes the prompt instead of answering it. */
	readonly denies?: boolean;
	/** The client cannot answer at all: it threw, or it is gone. */
	readonly unreachable?: boolean;
	/** What the engine checked in what the turn delivered (E149). */
	readonly delivered?: { checks: { what: string; how: string; passed: boolean; reason?: string }[] };
}

/**
 * Wires a real client to our agent, both ends of a real connection.
 *
 * The pipes are crossed the way a spawned process crosses them: what the client
 * writes is our input, and what we write is what it reads.
 */
function connect(script: Script) {
	const permissions: Record<string, unknown>[] = [];
	const updates: Record<string, unknown>[] = [];
	const approvals: boolean[] = [];
	const prompts: string[] = [];
	const opened: string[] = [];
	let cancelled = 0;

	const session: PersonaSession = {
		cancel: () => {
			cancelled += 1;
		},
		run: async (prompt: string, hooks: TurnHooks) => {
			prompts.push(prompt);
			if (script.asks) {
				approvals.push(
					await hooks.approve(
						{ name: script.asks.tool, args: { x: 1 }, id: script.asks.id },
						script.asks.reason,
					),
				);
			}
			for (const text of script.says ?? []) {
				hooks.emit({ kind: "agent.thought.streamed", text });
			}
			for (const call of script.calls ?? []) {
				hooks.emit({
					kind: "tool.call.requested",
					call_id: call.id,
					tool: call.tool,
					args_preview: "",
				});
				hooks.emit({ kind: "tool.call.completed", call_id: call.id, ok: call.ok !== false });
			}
			return { stopReason: script.stopReason ?? "answered", ...(script.delivered ? { delivered: script.delivered } : {}) };
		},
	};

	// Two Node pipes, wired the way the real pair is: what the client writes is our
	// input, and what we write is what it reads. Both ends go through our own
	// package rather than the vendor SDK, so this also says the two halves of
	// `@personaxis/protocol` can talk to each other.
	const clientToAgent = new PassThrough();
	const agentToClient = new PassThrough();

	serveAcpOverStdio({
		stdin: clientToAgent,
		stdout: agentToClient,
		agent: (acpClient: AcpServedClient) =>
			personaAgent(acpClient, {
				protocolVersion: ACP_PROTOCOL_VERSION,
				name: "personaxis",
				version: "test",
				open: async (cwd) => {
					opened.push(cwd);
					if (script.nowhere) throw new Error(`no persona in ${cwd}`);
					return session;
				},
			}),
	});

	const client = acpOverStdio({
		stdin: clientToAgent,
		stdout: agentToClient,
		client: {
			sessionUpdate: (params: { update: Record<string, unknown> }) => {
				updates.push(params.update);
			},
			requestPermission: async (params: Record<string, unknown>) => {
				permissions.push(params);
				if (script.unreachable) throw new Error("the editor went away");
				return script.asks && !script.denies
					? { outcome: { outcome: "selected", optionId: "allow" } }
					: { outcome: { outcome: "cancelled" } };
			},
		},
	});

	return {
		client,
		updates,
		permissions,
		approvals,
		prompts,
		opened,
		cancelled: () => cancelled,
	};
}

async function opened(script: Script) {
	const wired = connect(script);
	await wired.client.initialize({
		protocolVersion: ACP_PROTOCOL_VERSION,
		clientCapabilities: {},
	} as never);
	const session = await wired.client.newSession({ cwd: "C:/work", mcpServers: [] } as never);
	return { ...wired, sessionId: session.sessionId };
}

describe("an editor opening a session with one of our personas", () => {
	it("says who it is and what it cannot do", async () => {
		const wired = connect({});
		const response = (await wired.client.initialize({
			protocolVersion: ACP_PROTOCOL_VERSION,
			clientCapabilities: {},
		} as never)) as unknown as {
			agentCapabilities: { loadSession: boolean };
			agentInfo: { name: string };
		};

		expect(response.agentInfo.name).toBe("personaxis");
		// Said plainly rather than left to a default: we cannot resume a session that
		// ended, and advertising it would be a capability that fails on use.
		expect(response.agentCapabilities.loadSession).toBe(false);
	});

	it("opens the persona that lives in the directory it was given", async () => {
		const wired = await opened({});
		expect(wired.opened).toEqual(["C:/work"]);
		expect(wired.sessionId).toBeTruthy();
	});

	it("refuses a directory with no persona, rather than handing back an empty session", async () => {
		// A client that got a session id would show a working agent and wait.
		const wired = connect({ nowhere: true });
		await wired.client.initialize({ protocolVersion: ACP_PROTOCOL_VERSION } as never);

		await expect(
			wired.client.newSession({ cwd: "C:/empty", mcpServers: [] } as never),
		).rejects.toThrow();
	});
});

describe("a turn", () => {
	it("carries the prompt through and streams what the persona said", async () => {
		const wired = await opened({ says: ["on it", "done"] });

		const result = await wired.client.prompt({
			sessionId: wired.sessionId,
			prompt: [{ type: "text", text: "write the brief" }],
		} as never);

		expect(wired.prompts).toEqual(["write the brief"]);
		expect(result.stopReason).toBe("end_turn");
		expect(wired.updates.map((update) => update["sessionUpdate"])).toEqual([
			"agent_message_chunk",
			"agent_message_chunk",
		]);
	});

	it("shows tool calls opening and closing", async () => {
		const wired = await opened({ calls: [{ id: "c1", tool: "Read" }] });
		await wired.client.prompt({
			sessionId: wired.sessionId,
			prompt: [{ type: "text", text: "go" }],
		} as never);

		expect(wired.updates.map((update) => update["sessionUpdate"])).toEqual([
			"tool_call",
			"tool_call_update",
		]);
		expect(wired.updates[0]).toMatchObject({ name: "Read", toolCallId: "c1" });
	});

	it("translates our stop reasons into theirs", async () => {
		for (const [ours, theirs] of [
			["answered", "end_turn"],
			["empty", "end_turn"],
			["budget", "max_turn_requests"],
			["refused", "refusal"],
			["interrupted", "cancelled"],
			["failed", "refusal"],
		] as const) {
			const wired = await opened({ stopReason: ours });
			const result = await wired.client.prompt({
				sessionId: wired.sessionId,
				prompt: [{ type: "text", text: "go" }],
			} as never);
			expect(result.stopReason, ours).toBe(theirs);
		}
	});

	it("refuses a prompt for a session nobody opened", async () => {
		// Answered with an empty turn it would read as a persona that had nothing to
		// say, which is a different and wrong fact.
		const wired = connect({});
		await wired.client.initialize({ protocolVersion: ACP_PROTOCOL_VERSION } as never);

		await expect(
			wired.client.prompt({ sessionId: "never", prompt: [{ type: "text", text: "x" }] } as never),
		).rejects.toThrow();
	});
});

describe("what the engine found broken, said under the reply in the editor too (E149)", () => {
	const page = "C:/work/game.html";
	const said = "I have fixed the syntax error. The game should now run.";

	it("tells the editor, after the reply and before the turn is over, in the words the terminal uses", async () => {
		const wired = await opened({
			says: [said],
			delivered: {
				checks: [{ what: page, how: "ran it", passed: false, reason: `${page} does NOT run: on load, at line 6 of the file: SyntaxError: Unexpected identifier` }],
			},
		});
		await wired.client.prompt({ sessionId: wired.sessionId, prompt: [{ type: "text", text: "fix it" }] } as never);

		const texts = wired.updates.map((update) => String((update["content"] as { text?: unknown } | undefined)?.text ?? ""));
		expect(texts[0]).toBe(said);
		expect(texts[1]).toBe("\n\n⚠ Checked by Personaxis: game.html does NOT run: on load, at line 6 of the file: SyntaxError: Unexpected identifier");
		expect(wired.updates[1]).toMatchObject({ sessionUpdate: "agent_message_chunk" });
	});

	it("says nothing when every check passed, because a line under every good delivery is noise", async () => {
		const wired = await opened({ says: ["Done."], delivered: { checks: [{ what: page, how: "ran it", passed: true }] } });
		await wired.client.prompt({ sessionId: wired.sessionId, prompt: [{ type: "text", text: "go" }] } as never);

		expect(JSON.stringify(wired.updates)).not.toContain("Checked by Personaxis");
		expect(wired.updates).toHaveLength(1);
	});
});

describe("the envelope, in an application we do not control", () => {
	it("asks the person sitting there when the policy wants a person", async () => {
		// The thing none of the forty agents can do. It needs a compiled statement of
		// what a persona may do, which is what this product is.
		const wired = await opened({
			asks: { id: "c1", tool: "Bash", reason: "destructive command" },
		});

		await wired.client.prompt({
			sessionId: wired.sessionId,
			prompt: [{ type: "text", text: "go" }],
		} as never);

		expect(wired.permissions).toHaveLength(1);
		const toolCall = wired.permissions[0]!["toolCall"] as Record<string, unknown>;
		expect(toolCall["name"]).toBe("Bash");
		expect(String(toolCall["title"])).toContain("destructive command");
		expect(wired.approvals).toEqual([true]);
	});

	it("treats a client that cannot answer as a no", async () => {
		// The path that matters most and the one nothing was checking until a negative
		// control said so. A persona acting because the thing that would have said no
		// could not be asked is the failure this whole product exists to prevent, and
		// it is the failure that looks like nothing at all from inside the code.
		const wired = await opened({
			asks: { id: "c1", tool: "Bash", reason: "destructive command" },
			unreachable: true,
		});

		await wired.client.prompt({
			sessionId: wired.sessionId,
			prompt: [{ type: "text", text: "go" }],
		} as never);

		expect(wired.permissions).toHaveLength(1);
		expect(wired.approvals).toEqual([false]);
	});

	it("treats a closed prompt as a no", async () => {
		// `cancelled` is what an editor sends when the person dismisses the question
		// rather than answering it. Reading that as anything but a refusal would let a
		// persona act because nobody said no.
		const wired = await opened({
			asks: { id: "c1", tool: "Bash", reason: "destructive command" },
			denies: true,
		});

		await wired.client.prompt({
			sessionId: wired.sessionId,
			prompt: [{ type: "text", text: "go" }],
		} as never);

		expect(wired.permissions).toHaveLength(1);
		expect(wired.approvals).toEqual([false]);
	});
});

describe("cancelling", () => {
	it("reaches the turn in flight", async () => {
		const wired = await opened({});
		await wired.client.cancel({ sessionId: wired.sessionId } as never);
		expect(wired.cancelled()).toBe(1);
	});

	it("is ignored for a session that does not exist, which is a race not a fault", async () => {
		const wired = await opened({});
		await wired.client.cancel({ sessionId: "never" } as never);
		expect(wired.cancelled()).toBe(0);
	});
});
