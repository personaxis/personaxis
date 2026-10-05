/**
 * Both halves of the bridge over Node streams, with no process anywhere.
 *
 * `serveAcpOverStdio` is what an editor talks to when it drives one of our personas,
 * and `acpOverStdio` is what the daemon uses to drive somebody else's agent. Until
 * this file they were only exercised from the CLI package, so this package claimed a
 * coverage floor it never reached on its own. Here each is wired to the other through
 * two in-memory pipes, which is the same arrangement a real editor and a real child
 * process produce: one side's stdout is the other side's stdin.
 */

import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { ACP_PROTOCOL_VERSION, acpOverStdio, type AcpClient } from "./connect.js";
import { serveAcpOverStdio, servedStopReason, type AcpServedClient } from "./serve.js";

/** Two pipes, so that what one side writes the other side reads. */
function pipes() {
	return { toAgent: new PassThrough(), toClient: new PassThrough() };
}

describe("serveAcpOverStdio and acpOverStdio, wired to each other", () => {
	it("carries a handshake, a session and a turn, with the agent talking back mid-turn", async () => {
		const { toAgent, toClient } = pipes();
		const updates: Record<string, unknown>[] = [];
		const permissions: Record<string, unknown>[] = [];
		const prompts: unknown[] = [];

		serveAcpOverStdio({
			stdin: toAgent,
			stdout: toClient,
			agent: (client: AcpServedClient) => ({
				async initialize() {
					return { protocolVersion: ACP_PROTOCOL_VERSION, agentCapabilities: {} };
				},
				async newSession() {
					return { sessionId: "s-1" };
				},
				async prompt({ sessionId, prompt }) {
					prompts.push(prompt);
					await client.sessionUpdate({
						sessionId,
						update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "on it" } },
					});
					const answer = await client.requestPermission({
						sessionId,
						toolCall: { toolCallId: "t-1", title: "write a file", kind: "edit", status: "pending" },
						options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
					});
					const outcome = (answer as { outcome?: { outcome?: string } }).outcome?.outcome;
					return { stopReason: outcome === "selected" ? servedStopReason("answered") : servedStopReason("refused") };
				},
				cancel() {},
			}),
		});

		const client: AcpClient = {
			async requestPermission(params) {
				permissions.push(params);
				return { outcome: { outcome: "selected", optionId: "allow" } };
			},
			sessionUpdate(params) {
				updates.push(params.update);
			},
		};
		const connection = acpOverStdio({ stdin: toAgent, stdout: toClient, client });

		await connection.initialize({ protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: {} });
		const { sessionId } = await connection.newSession({ cwd: process.cwd(), mcpServers: [] });
		expect(sessionId).toBe("s-1");

		const result = (await (connection as unknown as {
			prompt(p: { sessionId: string; prompt: readonly Record<string, unknown>[] }): Promise<{ stopReason: string }>;
		}).prompt({ sessionId, prompt: [{ type: "text", text: "hello" }] })) as { stopReason: string };

		expect(result.stopReason).toBe("end_turn");
		expect(prompts).toHaveLength(1);
		expect(updates).toContainEqual({
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: "on it" },
		});
		expect(permissions).toHaveLength(1);
	});

	it("ends the turn as a refusal when the person on the client side says no", async () => {
		const { toAgent, toClient } = pipes();
		serveAcpOverStdio({
			stdin: toAgent,
			stdout: toClient,
			agent: (client) => ({
				async initialize() {
					return { protocolVersion: ACP_PROTOCOL_VERSION, agentCapabilities: {} };
				},
				async newSession() {
					return { sessionId: "s-2" };
				},
				async prompt({ sessionId }) {
					const answer = await client.requestPermission({
						sessionId,
						toolCall: { toolCallId: "t-2", title: "delete a file", kind: "delete", status: "pending" },
						options: [{ optionId: "deny", name: "Deny", kind: "reject_once" }],
					});
					const outcome = (answer as { outcome?: { outcome?: string } }).outcome?.outcome;
					return { stopReason: servedStopReason(outcome === "selected" ? "answered" : "refused") };
				},
				cancel() {},
			}),
		});
		const connection = acpOverStdio({
			stdin: toAgent,
			stdout: toClient,
			client: {
				async requestPermission() {
					return { outcome: { outcome: "cancelled" } };
				},
				sessionUpdate() {},
			},
		});
		await connection.initialize({ protocolVersion: ACP_PROTOCOL_VERSION });
		const { sessionId } = await connection.newSession({ cwd: process.cwd(), mcpServers: [] });
		const result = (await (connection as unknown as {
			prompt(p: { sessionId: string; prompt: readonly Record<string, unknown>[] }): Promise<{ stopReason: string }>;
		}).prompt({ sessionId, prompt: [{ type: "text", text: "delete it" }] })) as { stopReason: string };
		expect(result.stopReason).toBe("refusal");
	});
});

describe("servedStopReason", () => {
	it("maps our seven endings onto the protocol's five, and anything unknown to a refusal", () => {
		expect(servedStopReason("answered")).toBe("end_turn");
		expect(servedStopReason("empty")).toBe("end_turn");
		expect(servedStopReason("budget")).toBe("max_turn_requests");
		expect(servedStopReason("stopped")).toBe("max_turn_requests");
		expect(servedStopReason("refused")).toBe("refusal");
		expect(servedStopReason("interrupted")).toBe("cancelled");
		expect(servedStopReason("failed")).toBe("refusal");
		expect(servedStopReason("abandoned")).toBe("refusal");
		expect(servedStopReason("something-a-later-build-adds")).toBe("refusal");
	});
});
