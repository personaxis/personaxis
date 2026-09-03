/**
 * A persona, as an agent somebody else drives.
 *
 * The other direction of the bridge. `acp-session.ts` holds a session with a vendor
 * agent so our daemon can run one; this answers a session held by Zed, JetBrains,
 * VS Code, or anything else that speaks the protocol, so a person's editor can run
 * one of ours.
 *
 * Decision D1 of the plan, and the reason it is a decision rather than a nicety is
 * written there: the platform sells orchestration, a record and governance, not
 * exclusivity of access. Consequence, from the same paragraph: **nothing that only
 * works inside our own product may enter the definition of a persona.** This file is
 * where that consequence is either honoured or quietly broken, because everything a
 * persona needs has to survive being run somewhere we do not control.
 *
 * ## What crosses, and it is the whole differentiator
 *
 * A persona installed in somebody's editor arrives with its envelope. The gate runs
 * where it always ran, on this machine, against the policy compiled from the spec.
 * A call outside the envelope is refused in an application we did not write. And
 * when the policy wants a person rather than a rule, the question goes to the client
 * and the person sitting in that editor answers it.
 *
 * None of the forty agents this bridge can drive is able to do that, and it is not
 * because they have not got round to it: it needs a compiled statement of what a
 * persona may do, which is the thing this product is.
 *
 * ## Sessions are opened by the caller, not built here
 *
 * `open` is injected for the same reason `defaultLoop` takes its agent: who owns a
 * persona's lifetime is the caller's business. It also means every path through this
 * file is testable against a real client connection with no model, no key and no
 * files, which is what the tests do.
 */

import type { AcpServedAgent, AcpServedClient } from "@personaxis/protocol";
import { servedStopReason } from "@personaxis/protocol";
import type { WireEmission } from "@personaxis/core";

import { permissionGranted, permissionRequest, servedUpdate } from "./persona-updates.js";

/** What a persona needs told, mid-turn, and what it needs asked. */
export interface TurnHooks {
	/** Something happened worth showing. Already in the shared wire vocabulary. */
	readonly emit: (emission: WireEmission) => void;
	/**
	 * The policy wants a person. Resolves true only on an explicit yes.
	 *
	 * Not optional, and no default. A persona whose approvals nobody answered would
	 * refuse everything, which is safe, or allow everything, which is the hole; an
	 * omitted hook that picked either would be making a policy decision in a file
	 * whose job is transport.
	 */
	readonly approve: (call: { name: string; args: unknown; id: string }, reason: string) => Promise<boolean>;
}

/** One persona, opened against a directory, ready to take turns. */
export interface PersonaSession {
	/** Runs one turn. Returns OUR stop reason; the caller translates. */
	run(prompt: string, hooks: TurnHooks): Promise<{ stopReason: string }>;
	/** Ends the turn in flight. */
	cancel(): void;
}

export interface PersonaAgentOptions {
	/**
	 * Opens a persona for a working directory.
	 *
	 * Rejects when there is no persona there, and that rejection reaches the client
	 * as a failed `session/new` rather than as an empty session that answers
	 * everything with nothing. A client that got a session id would show a working
	 * agent and wait.
	 */
	readonly open: (cwd: string) => Promise<PersonaSession>;
	/** The protocol version this build speaks. */
	readonly protocolVersion: number;
	/** Names this agent to the client. */
	readonly name?: string;
	readonly version?: string;
}

/**
 * Builds the agent a client talks to.
 *
 * Every method is one the protocol requires. The optional ones are left off, and
 * that is a statement rather than a gap: `loadSession` would claim we can replay a
 * conversation from before this process started, and the record can do that but the
 * session cannot yet, so claiming it would be a capability that fails on use.
 */
export function personaAgent(
	client: AcpServedClient,
	options: PersonaAgentOptions,
): AcpServedAgent {
	const sessions = new Map<string, PersonaSession>();
	let counter = 0;

	return {
		initialize: async () => ({
			protocolVersion: options.protocolVersion,
			agentCapabilities: {
				// Said plainly rather than left to a default. We cannot resume a session
				// that ended, and an agent that advertised it would be one a client
				// rebuilt its whole restore path around.
				loadSession: false,
			},
			agentInfo: {
				name: options.name ?? "personaxis",
				...(options.version === undefined ? {} : { version: options.version }),
			},
		}),

		newSession: async (params) => {
			// The directory decides which persona this is, which is the same join the
			// hook uses: a persona lives beside the work it does.
			const session = await options.open(params.cwd);
			counter += 1;
			const sessionId = `px-${counter}`;
			sessions.set(sessionId, session);
			return { sessionId };
		},

		prompt: async (params) => {
			const session = sessions.get(params.sessionId);
			if (!session) {
				// A prompt for a session we never opened. Refused rather than answered
				// with an empty turn, because an empty turn reads as a persona that had
				// nothing to say.
				throw new Error(`no session ${params.sessionId}`);
			}

			const text = params.prompt
				.map((block) => (block["type"] === "text" ? String(block["text"] ?? "") : ""))
				.join("");

			const outcome = await session.run(text, {
				emit: (emission) => {
					const update = servedUpdate(emission);
					if (!update) return;
					// Not awaited. A notification that has not flushed must not hold up the
					// next step of a turn, and the connection preserves order on its own.
					void client.sessionUpdate({ sessionId: params.sessionId, update }).catch(() => {
						// A client that stopped listening is not a reason to fail a turn the
						// record is still writing. The turn ends and its result is durable
						// whether or not somebody watched it happen.
					});
				},
				approve: async (call, reason) => {
					const response = await client
						.requestPermission(permissionRequest(params.sessionId, call, reason))
						.catch(() => undefined);
					// An unreachable client is a refusal. The alternative is a persona
					// acting because the thing that would have said no could not be asked.
					return permissionGranted(response);
				},
			});

			return { stopReason: servedStopReason(outcome.stopReason) };
		},

		cancel: (params) => {
			sessions.get(params.sessionId)?.cancel();
		},
	};
}
