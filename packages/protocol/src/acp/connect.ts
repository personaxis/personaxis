/**
 * Opening an ACP connection over a child process's pipes.
 *
 * Here rather than in the daemon so that the vendor SDK has exactly one importer in
 * this repository. The daemon knows about consented directories, agent binaries and
 * killing children; it does not need to know how the protocol is framed, and a
 * dependency it does not name is a dependency it cannot drift on.
 *
 * The client is supplied rather than built, because what a client answers is a policy
 * question and this file is transport.
 */

import { Readable, Writable } from "node:stream";

import {
	ClientSideConnection,
	PROTOCOL_VERSION,
	ndJsonStream,
} from "@agentclientprotocol/sdk";

import type { AcpAgentConnection } from "./provider.js";

/** The two methods ACP requires of a client. Everything else is optional and omitted. */
export interface AcpClient {
	requestPermission(params: Record<string, unknown>): Promise<Record<string, unknown>>;
	sessionUpdate(params: { update: Record<string, unknown> }): void;
}

/** A live connection, plus the two calls a session needs before a turn can run. */
export interface AcpConnection extends AcpAgentConnection {
	initialize(params: {
		protocolVersion: number;
		clientCapabilities?: Record<string, unknown>;
	}): Promise<unknown>;
	newSession(params: {
		cwd: string;
		mcpServers: readonly unknown[];
	}): Promise<{ sessionId: string }>;
}

/** The protocol version this build speaks, for the handshake. */
export const ACP_PROTOCOL_VERSION: number = PROTOCOL_VERSION;

/**
 * Wires a client to an agent over a pair of Node streams.
 *
 * `stdin` and `stdout` are the child's, from the daemon's point of view: we write
 * requests into its input and read its output. Converted to Web streams here because
 * that is what the SDK takes, and doing it at the boundary means the caller passes
 * what it already has.
 */
export function acpOverStdio(options: {
	readonly stdin: NodeJS.WritableStream;
	readonly stdout: NodeJS.ReadableStream;
	readonly client: AcpClient;
}): AcpConnection {
	const stream = ndJsonStream(
		Writable.toWeb(options.stdin as never) as WritableStream<Uint8Array>,
		Readable.toWeb(options.stdout as never) as ReadableStream<Uint8Array>,
	);
	return new ClientSideConnection(() => options.client as never, stream) as unknown as AcpConnection;
}
