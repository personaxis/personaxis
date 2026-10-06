/**
 * The daemon holding a session with an agent, rather than shouting at one.
 *
 * The process and the transport are injected, so what is under test is the part that
 * matters: what reaches the room, what happens when nothing starts, and the fact that
 * nothing is permitted unless something says so.
 */

import { describe, expect, it, vi } from "vitest";

import { AcpSession, type PermissionAnswer } from "../src/workspace/acp-session.js";
import type { ChildProcess } from "../src/workspace/agent-process.js";

/** A child that exists and does nothing, because the transport is injected. */
function fakeChild(): ChildProcess & { killed: boolean } {
	const child = {
		exitCode: null,
		signalCode: null,
		killed: false,
		stdin: {},
		stdout: {},
		kill: () => {
			child.killed = true;
			return true;
		},
	};
	return child as unknown as ChildProcess & { killed: boolean };
}

interface Script {
	/** What the agent notifies while the turn runs. */
	readonly updates?: readonly Record<string, unknown>[];
	readonly stopReason?: string;
	/** Throws instead of answering the handshake. */
	readonly refusesToStart?: string;
	/** Asks permission for this tool before answering. */
	readonly asks?: {
		readonly title: string;
		readonly name?: string;
		readonly toolCallId?: string;
		readonly options: readonly unknown[];
	};
}

function session(
	script: Script,
	decide: (ask: { toolName: string }) => PermissionAnswer = () => ({
		allow: false,
		reason: "the gate is not wired yet",
	}),
) {
	const emitted: Record<string, unknown>[] = [];
	const skips: { reason: string; detail: string }[] = [];
	const child = fakeChild();
	const permissionOutcomes: unknown[] = [];
	let cancelled = false;

	const acp = new AcpSession({
		command: "claude-agent-acp",
		args: [],
		prompt: "do the thing",
		cwd: "C:/work",
		emit: (body) => emitted.push(body as Record<string, unknown>),
		onSkip: (reason, detail) => skips.push({ reason, detail }),
		decide: decide as never,
		spawnFn: (() => child) as never,
		connectFn: (_child, client) =>
			({
				initialize: async () => {
					if (script.refusesToStart) throw new Error(script.refusesToStart);
					return {};
				},
				newSession: async () => ({ sessionId: "s1" }),
				cancel: async () => {
					cancelled = true;
				},
				prompt: async () => {
					if (script.asks) {
						permissionOutcomes.push(
							await client.requestPermission({
								toolCall: {
									title: script.asks.title,
									...(script.asks.name === undefined ? {} : { name: script.asks.name }),
									...(script.asks.toolCallId === undefined
										? {}
										: { toolCallId: script.asks.toolCallId }),
									rawInput: {},
								},
								options: script.asks.options,
							}),
						);
					}
					for (const update of script.updates ?? []) client.sessionUpdate({ update });
					return { stopReason: script.stopReason ?? "end_turn" };
				},
			}) as never,
	});

	return { acp, emitted, skips, child, permissionOutcomes, wasCancelled: () => cancelled };
}

const said = (text: string) => ({
	sessionUpdate: "agent_message_chunk",
	content: { type: "text", text },
});

describe("a turn the room can watch", () => {
	it("opens the turn, streams the answer, closes it, and ends the session", async () => {
		const { acp, emitted } = session({ updates: [said("the thing is done")] });

		expect(await acp.run()).toBe("completed");
		expect(emitted.map((event) => event["kind"])).toEqual([
			"agent.turn.started",
			"agent.thought.streamed",
			"agent.turn.ended",
			"persona.session.ended",
		]);
		expect(emitted[2]).toMatchObject({ summary: "the thing is done" });
		expect(emitted[3]).toMatchObject({ status: "completed" });
	});

	it("shows tool calls as they happen", async () => {
		const { acp, emitted } = session({
			updates: [
				{ sessionUpdate: "tool_call", toolCallId: "c1", name: "read", status: "pending" },
				{ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed", rawOutput: "ok" },
			],
		});

		await acp.run();
		expect(emitted.map((event) => event["kind"])).toContain("tool.call.requested");
		expect(emitted.map((event) => event["kind"])).toContain("tool.call.completed");
	});

	it("kills the agent on the way out, on the good path too", async () => {
		const { acp, child } = session({});
		await acp.run();
		expect(child.killed).toBe(true);
	});
});

describe("when nothing starts", () => {
	it("still ends the session, because a job that hangs open is worse than a failed one", async () => {
		const { acp, emitted } = session({ refusesToStart: "spawn ENOENT" });

		expect(await acp.run()).toBe("failed");
		expect(emitted).toHaveLength(1);
		expect(emitted[0]).toMatchObject({ kind: "persona.session.ended", status: "failed" });
		expect(String(emitted[0]!["reason"])).toContain("acp_start");
	});

	it("kills whatever did start", async () => {
		const { acp, child } = session({ refusesToStart: "handshake never answered" });
		await acp.run();
		expect(child.killed).toBe(true);
	});
});

describe("nothing is permitted unless something says so", () => {
	const ALLOW_ONCE = [{ optionId: "yes", kind: "allow_once", name: "Allow" }];

	it("refuses by default and the room is told why", async () => {
		// The measured reason this matters: the ACP adapter loads `settingSources` of
		// `["user"]` or `[]`, so our project-scoped hook does not run. A permissive
		// default here would be an agent with nothing deciding for it.
		const { acp, permissionOutcomes, skips } = session({
			asks: { title: "rm -rf", options: ALLOW_ONCE },
		});

		await acp.run();

		expect(permissionOutcomes).toEqual([{ outcome: { outcome: "cancelled" } }]);
		expect(skips.some((skip) => skip.detail === "the gate is not wired yet")).toBe(true);
	});

	it("allows by selecting the option the agent offered, never one it did not", async () => {
		const { acp, permissionOutcomes } = session(
			{ asks: { title: "read", options: ALLOW_ONCE } },
			() => ({ allow: true }),
		);

		await acp.run();
		expect(permissionOutcomes).toEqual([
			{ outcome: { outcome: "selected", optionId: "yes" } },
		]);
	});

	it("an allow with no allow option offered is a refusal, and says so", async () => {
		// Sending an option id the agent never offered would be a protocol error
		// dressed as permission.
		const { acp, permissionOutcomes, skips } = session(
			{ asks: { title: "read", options: [{ optionId: "no", kind: "reject_once" }] } },
			() => ({ allow: true }),
		);

		await acp.run();
		expect(permissionOutcomes).toEqual([{ outcome: { outcome: "cancelled" } }]);
		expect(skips.some((skip) => skip.detail === "no allow option offered")).toBe(true);
	});

	it("asks about the tool by NAME, never by the sentence a person reads", async () => {
		// The gate matches rules against a tool name. A title ("Running ls in /work")
		// matches nothing, so a session that sent it would produce a gate that refuses
		// everything while appearing to work: correct-shaped and inert. This is the
		// only thing that says which one crosses.
		const seen: { toolName: string; callId?: string }[] = [];
		const { acp } = session(
			{
				asks: {
					name: "Bash",
					title: "Running ls in /work",
					toolCallId: "call_7",
					options: ALLOW_ONCE,
				},
			},
			(ask) => {
				seen.push(ask as { toolName: string; callId?: string });
				return { allow: false, reason: "no" };
			},
		);

		await acp.run();
		expect(seen[0]).toMatchObject({ toolName: "Bash", callId: "call_7" });
	});

	it("falls back to the title when the agent sent no name", async () => {
		// Better than refusing for want of a name. It is a fallback and not the rule.
		const seen: string[] = [];
		const { acp } = session({ asks: { title: "bash", options: ALLOW_ONCE } }, (ask) => {
			seen.push(ask.toolName);
			return { allow: false, reason: "no" };
		});

		await acp.run();
		expect(seen).toEqual(["bash"]);
	});
});

describe("how a session ends", () => {
	it("a refusal from the agent is a failed session, with the reason", async () => {
		const { acp, emitted } = session({ stopReason: "refusal" });
		expect(await acp.run()).toBe("failed");
		expect(emitted.at(-1)).toMatchObject({ status: "failed", reason: "refused" });
	});

	it("a ceiling is a completed session, because the turn did run", async () => {
		const { acp, emitted } = session({ stopReason: "max_tokens" });
		expect(await acp.run()).toBe("completed");
		expect(emitted.at(-1)).toMatchObject({ status: "completed" });
	});

	it("stopping between turns reaches nothing rather than the next one", async () => {
		const { acp, wasCancelled } = session({});
		await acp.run();
		acp.stop();
		expect(wasCancelled()).toBe(false);
	});
});

describe("the process it starts", () => {
	it("opens the pipe, which is the whole point of the phase", async () => {
		const spawnFn = vi.fn(() => fakeChild());
		const acp = new AcpSession({
			command: "claude-agent-acp",
			args: ["--stdio"],
			prompt: "hello",
			cwd: "C:/work",
			emit: () => {},
			decide: () => ({ allow: false, reason: "not yet" }),
			spawnFn: spawnFn as never,
			connectFn: () =>
				({
					initialize: async () => ({}),
					newSession: async () => ({ sessionId: "s1" }),
					cancel: async () => {},
					prompt: async () => ({ stopReason: "end_turn" }),
				}) as never,
		});

		await acp.run();

		expect(spawnFn).toHaveBeenCalledTimes(1);
		const [command, args, options] = spawnFn.mock.calls[0] as unknown as [
			string,
			string[],
			{ stdio: string[]; cwd: string },
		];
		expect(command).toBe("claude-agent-acp");
		expect(args).toEqual(["--stdio"]);
		// `pipe` rather than `ignore`: the difference between a session and a shot.
		expect(options.stdio[0]).toBe("pipe");
		// The consented directory, unchanged. The daemon's boundary decided it.
		expect(options.cwd).toBe("C:/work");
	});
});
