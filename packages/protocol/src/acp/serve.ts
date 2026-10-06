/**
 * Being driven, which is the other half of the bridge.
 *
 * `connect.ts` opens a session where WE drive somebody else's agent. This opens one
 * where somebody else drives ours: Zed, JetBrains, VS Code, or anything else that
 * speaks the protocol, holding a session with a persona.
 *
 * The plan calls this decision D1, both directions, and the reason it is a decision
 * rather than a nicety is written there: the platform sells orchestration, a record
 * and governance, not exclusivity of access. A persona that only works inside our
 * own Studio is a persona whose value depends on people using our screens.
 *
 * ## What is different about this direction, and it is not symmetry
 *
 * Driving, the gate answers the agent's permission questions. Being driven, the gate
 * still answers them, and when the policy wants a person we ask the CLIENT: the
 * editor holding the session puts the question in front of whoever is sitting there.
 *
 * So a persona installed in somebody's editor arrives with its envelope intact. It
 * refuses what it was told to refuse, in an application we do not control, and the
 * record of what it did is written on their machine. That is the thing none of the
 * forty agents can do, and it is why this file exists rather than a plugin.
 */

import { Readable, Writable } from "node:stream";

import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";

import type { AcpStopReason } from "./translate.js";

/** What a client asks of an agent, reduced to what a persona can honestly answer. */
export interface AcpServedAgent {
	initialize(params: Record<string, unknown>): Promise<Record<string, unknown>>;
	newSession(params: { cwd: string; mcpServers: readonly unknown[] }): Promise<{
		sessionId: string;
	}>;
	prompt(params: {
		sessionId: string;
		prompt: readonly Record<string, unknown>[];
	}): Promise<{ stopReason: string }>;
	cancel(params: { sessionId: string }): Promise<void> | void;
}

/**
 * The half of the connection an agent talks back through.
 *
 * Handed to the agent when it is built, because everything interesting a persona
 * does mid-turn goes this way: what it said, what it is about to call, and the
 * question it needs a person to answer.
 */
export interface AcpServedClient {
	sessionUpdate(params: { sessionId: string; update: Record<string, unknown> }): Promise<void>;
	requestPermission(params: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/**
 * Serves a persona over stdio, to whatever launched this process.
 *
 * `stdin` and `stdout` are OURS here, which is the mirror of `acpOverStdio`: the
 * editor writes requests into our input and reads our output. Getting that backwards
 * produces a process that talks to itself and a client that waits forever, so the
 * direction is named in the parameters rather than left to a reader to work out.
 */
export function serveAcpOverStdio(options: {
	readonly stdin: NodeJS.ReadableStream;
	readonly stdout: NodeJS.WritableStream;
	readonly agent: (client: AcpServedClient) => AcpServedAgent;
}): void {
	const stream = ndJsonStream(
		Writable.toWeb(options.stdout as never) as WritableStream<Uint8Array>,
		Readable.toWeb(options.stdin as never) as ReadableStream<Uint8Array>,
	);
	new AgentSideConnection(
		(connection) => options.agent(connection as unknown as AcpServedClient) as never,
		stream,
	);
}

/**
 * The words we may end a turn with, which are the same five ACP has.
 *
 * Derived from `ACP_STOP_REASONS` rather than written out again, and the first draft
 * of this file did write them out again. `designed-not-connected` caught the copy
 * within the hour: a second list nothing consumed, beside a first list that already
 * has the guard comparing it to the shipped schema. Two lists means the guard covers
 * one of them, and the day the protocol adds a sixth word the uncovered one keeps
 * compiling and stops being true.
 */
export type ServedStopReason = AcpStopReason;

/**
 * Our seven, back into their five.
 *
 * The inverse of `translate.ts`, and lossy in the direction that matters least: a
 * client does not need to know whether a ceiling was tokens or steps, it needs to
 * know the turn ended and whether it ended well.
 *
 * `empty` is the interesting one again. A turn that produced nothing IS an ended
 * turn as far as the protocol is concerned, and there is no word for "finished and
 * said nothing"; the client sees the absence of content, which is the same thing it
 * would see from any other agent that did that.
 */
export function servedStopReason(ours: string): ServedStopReason {
	switch (ours) {
		case "answered":
		case "empty":
			return "end_turn";
		case "budget":
		case "stopped":
			return "max_turn_requests";
		case "refused":
			return "refusal";
		case "interrupted":
			return "cancelled";
		default:
			// `failed`, `abandoned`, and anything a later build adds. Reported as a
			// refusal rather than as a clean end, because a client that heard `end_turn`
			// would show the person a turn that finished normally and produced nothing,
			// and they would ask it again.
			return "refusal";
	}
}
