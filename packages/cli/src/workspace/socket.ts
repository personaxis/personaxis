/**
 * The real socket, behind the interface the connection actually depends on.
 *
 * Node's global `WebSocket` is used rather than a dependency. `ws` would work
 * and `keytar` taught this repo what a native addon costs; here the reason is
 * narrower: one more package in every `npm i -g personaxis` to do what the
 * runtime already does. The cost is a Node floor, and the floor is stated in
 * the error rather than discovered as a crash.
 *
 * The token travels in the `Authorization` header of the upgrade request, not
 * in the query string. A URL ends up in proxy logs, in browser history and in
 * error reports; a header does not.
 */

import type { DaemonSocket, SocketFactory } from "./connection.js";

/** Node version where the WebSocket global stopped needing a flag. */
export const MIN_NODE_MAJOR_FOR_SOCKET = 22;

export function socketSupported(): boolean {
	return typeof globalThis.WebSocket === "function";
}

export function unsupportedSocketMessage(): string {
	return (
		`Connecting needs the WebSocket support built into Node ${MIN_NODE_MAJOR_FOR_SOCKET} and later. ` +
		`This is Node ${process.versions.node}. Every other command works as before; upgrade Node to link this machine.`
	);
}

/**
 * Wraps the runtime WebSocket into the four callbacks the connection uses.
 *
 * Deliberately thin. Reconnection, backoff, queueing and heartbeats all live in
 * the connection, where they can be tested without a network.
 */
export const nodeSocketFactory: SocketFactory = (url: string, token: string): DaemonSocket => {
	if (!socketSupported()) throw new Error(unsupportedSocketMessage());

	// The options bag is undici's, not the browser's. On a runtime that ignores
	// it the upgrade arrives without credentials and the gateway answers 401,
	// which is the correct failure rather than a silent unauthenticated socket.
	const socket = new (globalThis.WebSocket as unknown as new (
		url: string,
		options?: unknown,
	) => WebSocket)(url, {
		headers: { Authorization: `Bearer ${token}` },
	});

	return {
		send: (data) => socket.send(data),
		close: (code, reason) => socket.close(code, reason),
		onOpen: (handler) => socket.addEventListener("open", () => handler()),
		onMessage: (handler) =>
			socket.addEventListener("message", (event: MessageEvent) => {
				if (typeof event.data === "string") handler(event.data);
			}),
		onClose: (handler) =>
			socket.addEventListener("close", (event: CloseEvent) =>
				handler(event.code, event.reason),
			),
		onError: (handler) => socket.addEventListener("error", (event) => handler(event)),
	};
};
