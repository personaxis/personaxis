/**
 * Linking a machine to a workspace, without the machine ever handling a
 * password.
 *
 * The shape is the device authorization grant (RFC 8628) with the proof key of
 * PKCE (RFC 7636) bolted on, and the second half is the part that matters here:
 * the daemon invents a secret, sends only its hash to the server, and later
 * proves it holds the original. So the approval link, which travels through a
 * browser, a clipboard and possibly a chat window, is not enough on its own to
 * collect the token. Someone who sees the link can approve a machine they can
 * see; they cannot walk away with its credential.
 *
 * Everything here takes its clock, its randomness and its transport as
 * arguments. That is not ceremony: a login flow that can only be tested against
 * a live server is a login flow that is tested once.
 */

import { createHash, randomBytes } from "node:crypto";

/** Bytes of entropy behind the verifier. 32 gives a 43-character string. */
const VERIFIER_BYTES = 32;

/** The whole flow has this long before the daemon gives up. */
export const DEFAULT_DEADLINE_MS = 5 * 60 * 1000;

/** How often the daemon asks, when the server does not say otherwise. */
export const DEFAULT_POLL_INTERVAL_MS = 2000;

export interface DeviceFlowIO {
	fetch: typeof fetch;
	now: () => number;
	sleep: (ms: number) => Promise<void>;
	randomBytes: (n: number) => Buffer;
}

export const defaultDeviceFlowIO: DeviceFlowIO = {
	fetch: (...args) => fetch(...args),
	now: () => Date.now(),
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	randomBytes,
};

export interface StartedFlow {
	verifier: string;
	challenge: string;
	/** The page a person opens and approves. */
	verification_url: string;
	expires_at: number;
	poll_interval_ms: number;
}

export interface ClaimedToken {
	token: string;
	machine_id: string;
	/** `org:<id>` or `usr:<id>`. The same spelling the gateway compares against. */
	space: string;
	/** What to print, so the operator sees where their machine landed. */
	space_name: string;
}

export type ClaimOutcome =
	| { status: "approved"; value: ClaimedToken }
	| { status: "denied"; reason: string }
	| { status: "expired"; reason: string }
	| { status: "failed"; reason: string };

/** A high-entropy secret the daemon keeps until it claims the token. */
export function createVerifier(io: DeviceFlowIO = defaultDeviceFlowIO): string {
	return io.randomBytes(VERIFIER_BYTES).toString("base64url");
}

/** What the server stores. The verifier itself never reaches it until the claim. */
export function challengeFor(verifier: string): string {
	return createHash("sha256").update(verifier).digest("base64url");
}

export interface MachineIntroduction {
	machine_name: string;
	os: string;
	daemon_version: string;
}

/**
 * Announces the machine and gets back the page to approve it.
 *
 * The introduction is shown on that page. It is not trusted for anything else:
 * a machine describing itself is a claim, and the workspace treats it as one.
 */
export async function startDeviceFlow(
	appUrl: string,
	machine: MachineIntroduction,
	io: DeviceFlowIO = defaultDeviceFlowIO,
): Promise<StartedFlow> {
	const verifier = createVerifier(io);
	const challenge = challengeFor(verifier);

	const response = await io.fetch(`${appUrl}/api/v1/device/start`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify({ challenge, ...machine }),
	});

	if (!response.ok) {
		throw new Error(await describeFailure(response, "could not start the device flow"));
	}

	const body = (await response.json().catch(() => ({}))) as {
		verification_url?: string;
		expires_in_seconds?: number;
		poll_interval_seconds?: number;
	};
	if (!body.verification_url) {
		throw new Error("the workspace did not return a verification URL");
	}

	return {
		verifier,
		challenge,
		verification_url: body.verification_url,
		expires_at:
			io.now() + (body.expires_in_seconds ? body.expires_in_seconds * 1000 : DEFAULT_DEADLINE_MS),
		poll_interval_ms: body.poll_interval_seconds
			? body.poll_interval_seconds * 1000
			: DEFAULT_POLL_INTERVAL_MS,
	};
}

/**
 * Waits for a person to approve, then collects the token exactly once.
 *
 * Four outcomes, all of them final and all of them named. There is no fifth
 * where the daemon keeps polling forever: a flow that never ends is a flow that
 * holds a terminal hostage, and the operator learns nothing from it.
 */
export async function claimDeviceToken(
	appUrl: string,
	flow: StartedFlow,
	io: DeviceFlowIO = defaultDeviceFlowIO,
	onWait?: (secondsLeft: number) => void,
): Promise<ClaimOutcome> {
	let interval = flow.poll_interval_ms;

	while (io.now() < flow.expires_at) {
		let response: Response;
		try {
			response = await io.fetch(`${appUrl}/api/v1/device/claim`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Accept: "application/json" },
				body: JSON.stringify({ verifier: flow.verifier }),
			});
		} catch (error) {
			// A network blip during a five minute wait is normal. Backing off and
			// retrying is right; failing the link because a laptop changed
			// networks would not be.
			interval = Math.min(interval * 2, 15000);
			await io.sleep(interval);
			continue;
		}

		if (response.status === 200) {
			const body = (await response.json().catch(() => null)) as
				| { token?: string; machine_id?: string; space?: { kind?: string; id?: string }; space_name?: string }
				| null;
			const kind = body?.space?.kind;
			const id = body?.space?.id;
			if (!body?.token || !body.machine_id || !id || (kind !== "org" && kind !== "user")) {
				return { status: "failed", reason: "the workspace approved the machine but returned no token" };
			}
			const space = `${kind === "org" ? "org" : "usr"}:${id}`;
			return {
				status: "approved",
				value: {
					token: body.token,
					machine_id: body.machine_id,
					space,
					space_name: body.space_name ?? space,
				},
			};
		}

		if (response.status === 202) {
			onWait?.(Math.max(0, Math.round((flow.expires_at - io.now()) / 1000)));
			await io.sleep(interval);
			continue;
		}

		if (response.status === 403) {
			return { status: "denied", reason: "the request was declined in the browser" };
		}

		if (response.status === 410 || response.status === 404) {
			// 404 is folded in with expiry on purpose. A pending row that is gone
			// is a row that timed out and was swept, and telling the two apart
			// would tell a caller whether a challenge ever existed.
			return { status: "expired", reason: "the approval request is no longer valid" };
		}

		if (response.status === 429) {
			interval = Math.min(interval * 2, 15000);
			await io.sleep(interval);
			continue;
		}

		return { status: "failed", reason: await describeFailure(response, "the claim failed") };
	}

	return { status: "expired", reason: "nobody approved this machine in time" };
}

async function describeFailure(response: Response, fallback: string): Promise<string> {
	try {
		const body = (await response.json()) as { error?: string | { message?: string } };
		const message = typeof body.error === "string" ? body.error : body.error?.message;
		if (message) return `${message} (HTTP ${response.status})`;
	} catch {
		/* fall through to the status alone */
	}
	return `${fallback} (HTTP ${response.status})`;
}
