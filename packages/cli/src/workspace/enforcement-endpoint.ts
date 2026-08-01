/**
 * The local channel between a host's hook and the daemon.
 *
 * The hook is a short-lived process the host spawns before every tool call. It
 * knows nothing: not the persona, not the policy, not the workspace. It asks
 * one question over a local socket and does what it is told. Keeping it that
 * thin is what makes it fast enough to sit in front of every call, and what
 * makes a second host adapter a matter of translating one payload.
 *
 * The transport is the same one the engine already speaks (JSON-RPC over
 * node:net: Unix sockets on POSIX, named pipes on Windows), so this adds a
 * method rather than a mechanism.
 *
 * Nothing about the file system leaves this machine through here, and nothing
 * arrives through it either: the socket is local, unnamed on the network, and
 * the only method it answers is `enforce`.
 */

import { createHash } from "node:crypto";
import { unlinkSync } from "node:fs";
import { createServer, connect, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectionFor } from "@personaxis/protocol";

/** What the hook asks. */
export interface EnforceRequest {
	tool_name: string;
	args_text: string;
	cwd: string;
	tool_use_id?: string;
	session_id?: string;
}

/** What the daemon answers. Shaped for the host contract, not for the engine. */
export interface EnforceReply {
	verdict: "allow" | "deny";
	rule: string;
	reason: string;
}

export const ENFORCE_METHOD = "enforce";

/**
 * The endpoint for a working directory.
 *
 * Derived from the directory rather than from the persona, because the hook is
 * spawned inside a repository and that path is the only thing it reliably
 * knows. Two consented directories therefore get two endpoints, and a daemon
 * serving both answers on both.
 */
export function enforcementSocketPath(root: string): string {
	const digest = createHash("sha256").update(root.replace(/\\/g, "/")).digest("hex").slice(0, 12);
	if (process.platform === "win32") return `\\\\.\\pipe\\personaxis-enforce-${digest}`;
	const runtimeDir = process.env.XDG_RUNTIME_DIR ?? tmpdir();
	return join(runtimeDir, `personaxis-enforce-${digest}.sock`);
}

export type EnforceHandler = (request: EnforceRequest) => Promise<EnforceReply>;

/**
 * Serves decisions on one endpoint.
 *
 * A handler that throws answers with a denial rather than dropping the
 * connection: the hook is waiting, and a hook that waits for a socket that went
 * quiet ends in the host's timeout, which is a slower and less informative
 * version of the same refusal.
 */
export function serveEnforcement(socketPath: string, handle: EnforceHandler): Server {
	const server = createServer((socket: Socket) => {
		const connection = connectionFor(socket);
		connection.onRequest(ENFORCE_METHOD, async (request: EnforceRequest): Promise<EnforceReply> => {
			try {
				return await handle(request);
			} catch (error) {
				return {
					verdict: "deny",
					rule: "daemon_error",
					reason: `the daemon could not decide: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
		});
		connection.listen();
		socket.on("error", () => {
			/* a hook that died mid-question is normal */
		});
	});

	// A socket file left behind by a daemon that was killed would make listen
	// fail with EADDRINUSE forever. Removing it is safe: if another daemon were
	// actually listening, the connect below would have succeeded.
	if (process.platform !== "win32") {
		try {
			unlinkSync(socketPath);
		} catch {
			/* nothing there, which is the normal case */
		}
	}

	server.listen(socketPath);
	return server;
}

/**
 * Asks the daemon, from the hook.
 *
 * The timeout is the hook's own, shorter than the host's, so the answer to a
 * daemon that is not answering comes from us with a reason rather than from the
 * host with a stopped process. Rejects on every failure; the caller turns that
 * into a denial.
 */
export function askDaemon(
	socketPath: string,
	request: EnforceRequest,
	timeoutMs: number,
): Promise<EnforceReply> {
	return new Promise((resolve, reject) => {
		const socket = connect(socketPath);
		const connection = connectionFor(socket);

		const timer = setTimeout(() => {
			cleanup();
			reject(new Error(`the daemon did not answer within ${timeoutMs} ms`));
		}, timeoutMs);
		// Deliberately not unref'd: this timer is the only thing that ends a
		// wait on a daemon that accepted the socket and then went silent.

		const cleanup = () => {
			clearTimeout(timer);
			try {
				connection.dispose();
			} catch {
				/* already gone */
			}
			socket.destroy();
		};

		socket.on("error", (error) => {
			cleanup();
			reject(error);
		});

		connection.listen();
		connection
			.sendRequest(ENFORCE_METHOD, request)
			.then((reply) => {
				cleanup();
				resolve(reply as EnforceReply);
			})
			.catch((error) => {
				cleanup();
				reject(error instanceof Error ? error : new Error(String(error)));
			});
	});
}
