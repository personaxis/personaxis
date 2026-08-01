/**
 * Where the workspace lives, resolved once.
 *
 * Two hosts, because they are two deployables: the app answers requests, the
 * gateway holds sockets open. Both are overridable by environment variable so a
 * self-hosted workspace is a configuration change and not a fork, and so the
 * end-to-end tests can point the daemon at a local server.
 *
 * `PERSONAXIS_BASE_URL` already existed for the REST client; it keeps its
 * meaning here rather than gaining a second name.
 */

export const DEFAULT_APP_URL = "https://personaxis.com";
export const DEFAULT_GATEWAY_URL = "wss://gw.personaxis.com";

/** The app: REST, the device authorization page, everything request-response. */
export function appUrl(env: NodeJS.ProcessEnv = process.env): string {
	return normalize(env.PERSONAXIS_BASE_URL ?? DEFAULT_APP_URL, ["http:", "https:"], "PERSONAXIS_BASE_URL");
}

/**
 * The gateway: the daemon socket.
 *
 * Derived from the app URL when only that is overridden, so pointing a daemon
 * at a local stack takes one variable instead of two that can disagree.
 */
export function gatewayUrl(env: NodeJS.ProcessEnv = process.env): string {
	const explicit = env.PERSONAXIS_GATEWAY_URL;
	if (explicit) {
		return normalize(explicit, ["ws:", "wss:"], "PERSONAXIS_GATEWAY_URL");
	}
	const base = env.PERSONAXIS_BASE_URL;
	if (!base) return DEFAULT_GATEWAY_URL;

	// A local app implies a local gateway. Guessing the public gateway here
	// would send a development daemon at production, which is the kind of
	// mistake that is only noticed from the other side.
	const url = new URL(normalize(base, ["http:", "https:"], "PERSONAXIS_BASE_URL"));
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	return normalize(url.toString(), ["ws:", "wss:"], "PERSONAXIS_GATEWAY_URL");
}

/** The socket the daemon opens, including the path the gateway routes on. */
export function daemonSocketUrl(env: NodeJS.ProcessEnv = process.env): string {
	return `${gatewayUrl(env)}/v1/daemon`;
}

function normalize(raw: string, allowed: string[], name: string): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error(`${name} is not a URL: ${raw}`);
	}
	if (!allowed.includes(url.protocol)) {
		// Named rather than silently coerced. A daemon that quietly downgraded
		// wss to ws would send a device token in the clear.
		throw new Error(`${name} must use ${allowed.join(" or ")}, got ${url.protocol}`);
	}
	return url.toString().replace(/\/+$/, "");
}
