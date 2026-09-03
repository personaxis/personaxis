/**
 * The provider against a real ACP connection, with no process anywhere.
 *
 * Two in-memory pipes, a real `ClientSideConnection` on one end and a real
 * `AgentSideConnection` on the other, and a scripted agent in between. Every
 * assertion here has been over the wire and through the SDK's own encoding, which
 * is the difference between testing our translation and testing our idea of what
 * the protocol does.
 *
 * The thing being proved is `A1`'s verification: the same shape as `defaultLoop`,
 * failures included, with all seven stop reasons reachable.
 */

import {
	AgentSideConnection,
	ClientSideConnection,
	PROTOCOL_VERSION,
	ndJsonStream,
} from "@agentclientprotocol/sdk";
import type { run } from "@personaxis/core";
import { describe, expect, it } from "vitest";

import { AcpTurnCollector, acpLoop, type AcpProvider } from "./provider.js";

/** What a turn should do on the agent's side. */
interface Script {
	readonly says?: readonly {
		readonly kind: "agent_message_chunk" | "agent_thought_chunk" | "user_message_chunk";
		readonly text: string;
	}[];
	readonly tools?: readonly string[];
	readonly stopReason?: string;
	/** Session running total, as ACP reports it: on the response to the prompt. */
	readonly sessionTokens?: number;
	/** Cumulative session cost, as ACP reports it: on `usage_update`. */
	readonly sessionCost?: { readonly amount: number; readonly currency: string };
	/** How full the context window is. Not a cost, and never charged as one. */
	readonly context?: { readonly used: number; readonly size: number };
	/** Waits for `session/cancel` and then answers `cancelled`, as the spec requires. */
	readonly waitForCancel?: boolean;
	/** Throws instead of answering, which is a dead connection from our side. */
	readonly explodes?: string;
}

const SESSION = "session-under-test";

/**
 * Wires a client to a scripted agent and returns the provider plus a way to see
 * what the agent was told.
 */
function connect(script: Script): {
	provider: AcpProvider;
	cancels: string[];
	prompts: string[];
} {
	const cancels: string[] = [];
	const prompts: string[] = [];
	let cancelled: (() => void) | undefined;

	const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
	const agentToClient = new TransformStream<Uint8Array, Uint8Array>();

	const collector = new AcpTurnCollector();

	// The agent side. Only the four methods ACP requires.
	const agent = {
		initialize: () => ({
			protocolVersion: PROTOCOL_VERSION,
			agentCapabilities: { loadSession: false },
		}),
		newSession: () => ({ sessionId: SESSION }),
		cancel: (params: { sessionId: string }) => {
			cancels.push(params.sessionId);
			cancelled?.();
		},
		prompt: async (params: { sessionId: string; prompt: unknown }) => {
			prompts.push(JSON.stringify(params.prompt));
			const tokens = (): { usage?: { totalTokens: number } } =>
				script.sessionTokens === undefined
					? {}
					: { usage: { totalTokens: script.sessionTokens } };
			if (script.explodes !== undefined) throw new Error(script.explodes);

			for (const said of script.says ?? []) {
				await connection.sessionUpdate({
					sessionId: params.sessionId,
					update: {
						sessionUpdate: said.kind,
						content: { type: "text", text: said.text },
					},
				});
			}
			for (const id of script.tools ?? []) {
				await connection.sessionUpdate({
					sessionId: params.sessionId,
					update: {
						sessionUpdate: "tool_call",
						toolCallId: id,
						title: id,
						status: "pending",
					},
				});
			}
			// A cost cannot be sent on its own: the protocol requires the window with it.
			if (script.context !== undefined) {
				await connection.sessionUpdate({
					sessionId: params.sessionId,
					update: {
						sessionUpdate: "usage_update",
						used: script.context.used,
						size: script.context.size,
						...(script.sessionCost === undefined ? {} : { cost: script.sessionCost }),
					},
				});
			}
			if (script.waitForCancel === true) {
				await new Promise<void>((resolve) => {
					cancelled = resolve;
				});
				return { stopReason: "cancelled" };
			}
			return { stopReason: script.stopReason ?? "end_turn", ...tokens() };
		},
	};

	// eslint-disable-next-line prefer-const
	let connection: AgentSideConnection;
	connection = new AgentSideConnection(
		() => agent as never,
		ndJsonStream(agentToClient.writable, clientToAgent.readable),
	);

	const client = new ClientSideConnection(
		() =>
			({
				requestPermission: () => ({ outcome: { outcome: "cancelled" } }),
				sessionUpdate: (params: { update: Record<string, unknown> }) =>
					collector.sessionUpdate(params),
			}) as never,
		ndJsonStream(clientToAgent.writable, agentToClient.readable),
	);

	return {
		provider: acpLoop({
			connection: client as never,
			sessionId: SESSION,
			collector,
			agentName: "scripted",
		}),
		cancels,
		prompts,
	};
}

/** A turn context, with room by default. */
function context(options: { room?: () => boolean; signal?: AbortSignal } = {}): {
	ctx: run.TurnContext;
	steps: () => number;
} {
	let steps = 0;
	return {
		steps: () => steps,
		ctx: {
			request: {
				turn: "t1",
				prompt: "do the thing",
				asker: { kind: "human", id: "david" },
			},
			hasRoom: options.room ?? (() => true),
			stepDone: () => {
				steps += 1;
			},
			...(options.signal === undefined ? {} : { signal: options.signal }),
		},
	};
}

describe("a turn over a real ACP connection", () => {
	it("names itself after the agent it drives", () => {
		expect(connect({}).provider.name).toBe("acp:scripted");
	});

	it("answers, carrying only what the agent said", async () => {
		const { provider, prompts } = connect({
			says: [
				{ kind: "user_message_chunk", text: "do the thing" },
				{ kind: "agent_thought_chunk", text: "hmm, let me consider" },
				{ kind: "agent_message_chunk", text: "the thing is done" },
			],
		});

		const product = await provider.run(context().ctx);

		expect(product.stopReason).toBe("answered");
		// Three kinds of content came down one channel and exactly one is the reply.
		// A collector that concatenated them would attribute our own question and the
		// agent's reasoning to the persona, which is the ninth gap the study named.
		expect(product.answer).toBe("the thing is done");
		expect(prompts[0]).toContain("do the thing");
	});

	it("reports an agent that finished without saying anything as empty", async () => {
		const product = await connect({ says: [] }).provider.run(context().ctx);
		expect(product.stopReason).toBe("empty");
		expect(product.answer).toBe("");
	});

	it("turns the agent's own ceiling into budget", async () => {
		const { provider } = connect({
			stopReason: "max_tokens",
			says: [{ kind: "agent_message_chunk", text: "as far as I got" }],
		});
		const product = await provider.run(context().ctx);
		expect(product.stopReason).toBe("budget");
		expect(product.answer).toBe("as far as I got");
	});

	it("turns a refusal into refused", async () => {
		const product = await connect({ stopReason: "refusal" }).provider.run(context().ctx);
		expect(product.stopReason).toBe("refused");
	});

	it("counts a tool call as a step, once, however often it is updated", async () => {
		const { provider } = connect({ tools: ["call-a", "call-b", "call-a"] });
		const { ctx, steps } = context();

		const product = await provider.run(ctx);

		expect(product.steps).toBe(2);
		// And the ledger heard about each one as it landed, which is what makes a
		// ceiling bind inside a turn instead of only between turns.
		expect(steps()).toBe(2);
	});

	it("says nothing about cost when the agent said nothing", async () => {
		expect((await connect({}).provider.run(context().ctx)).cost).toBeUndefined();
	});
});

describe("cost, which ACP only ever reports as a session running total", () => {
	it("charges a turn for what the total grew by, not for the total", async () => {
		// The expensive mistake this guards. `totalTokens` is the whole session, and
		// it arrives on the response to one prompt, exactly where a per-turn figure
		// would arrive. Passed straight through, turn three below would be billed
		// 3.000 tokens for the 900 it actually spent, and every number in the ledger
		// would look plausible while being the wrong answer to the wrong question.
		const script = { sessionTokens: 0 };
		const { provider } = connect(
			new Proxy(script, {
				get: (target, key) => (key === "sessionTokens" ? target.sessionTokens : undefined),
			}) as never,
		);

		script.sessionTokens = 1000;
		expect((await provider.run(context().ctx)).cost?.tokens).toBe(1000);

		script.sessionTokens = 2100;
		expect((await provider.run(context().ctx)).cost?.tokens).toBe(1100);

		script.sessionTokens = 3000;
		expect((await provider.run(context().ctx)).cost?.tokens).toBe(900);
	});

	it("reads a counter that went backwards as a restart, never as a refund", async () => {
		const script = { sessionTokens: 0 };
		const { provider } = connect(
			new Proxy(script, {
				get: (target, key) => (key === "sessionTokens" ? target.sessionTokens : undefined),
			}) as never,
		);

		script.sessionTokens = 5000;
		await provider.run(context().ctx);
		script.sessionTokens = 200;

		// A negative charge would credit the tenant for an agent restarting.
		expect((await provider.run(context().ctx)).cost?.tokens).toBe(200);
	});

	it("takes money only in the currency the field is named after", async () => {
		// `used` and `size` travel with it because the protocol requires them: a cost
		// cannot be reported on its own, and a notification without them is dropped
		// by the SDK's own validation before it ever reaches us.
		const window = { used: 10, size: 100 };
		const inDollars = connect({
			context: window,
			sessionCost: { amount: 3.5, currency: "USD" },
		});
		expect((await inDollars.provider.run(context().ctx)).cost).toEqual({
			tokens: 0,
			usd: 3.5,
		});

		// Four euros in a field everything downstream adds up as dollars is a wrong
		// number, and converting it here would invent the rate.
		const inEuros = connect({
			context: window,
			sessionCost: { amount: 4, currency: "EUR" },
		});
		expect((await inEuros.provider.run(context().ctx)).cost).toBeUndefined();
	});

	it("never charges the context window, which is not a spend", async () => {
		// `used` and `size` say how full the window is. A long conversation has a big
		// context and can still take a cheap turn.
		const { provider } = connect({ context: { used: 80_000, size: 200_000 } });
		expect((await provider.run(context().ctx)).cost).toBeUndefined();
	});
});

describe("the four ways we end a turn ourselves", () => {
	it("a person pressing stop is interrupted", async () => {
		const controller = new AbortController();
		const { provider, cancels } = connect({ waitForCancel: true });
		const { ctx } = context({ signal: controller.signal });

		const running = provider.run(ctx);
		controller.abort();

		expect((await running).stopReason).toBe("interrupted");
		expect(cancels).toEqual([SESSION]);
	});

	it("running out of room mid-turn is budget, not an interruption", async () => {
		// The agent says `cancelled` for all four of these. Only we know which it was.
		const { provider } = connect({ waitForCancel: true, tools: ["one"] });
		const product = await provider.run(context({ room: () => false }).ctx);
		expect(product.stopReason).toBe("budget");
	});

	it("a declared rule firing is stopped, which is not a budget", async () => {
		const { provider } = connect({ waitForCancel: true });
		const running = provider.run(context().ctx);
		provider.stop("stopped");
		expect((await running).stopReason).toBe("stopped");
	});

	it("a guard refusing is refused", async () => {
		const { provider } = connect({ waitForCancel: true });
		const running = provider.run(context().ctx);
		provider.stop("refused");
		expect((await running).stopReason).toBe("refused");
	});

	it("keeps what the agent managed to say before it was stopped", async () => {
		const { provider } = connect({
			waitForCancel: true,
			says: [{ kind: "agent_message_chunk", text: "I had started" }],
		});
		const running = provider.run(context().ctx);
		provider.stop("stopped");
		expect((await running).answer).toBe("I had started");
	});

	it("sends one cancel however many times it is asked", async () => {
		const { provider, cancels } = connect({ waitForCancel: true });
		const running = provider.run(context().ctx);
		provider.stop("stopped");
		provider.stop("interrupted");
		provider.stop("budget");
		await running;
		expect(cancels).toEqual([SESSION]);
	});

	it("a stop between turns reaches nothing, rather than the next turn", async () => {
		const { provider, cancels } = connect({});
		await provider.run(context().ctx);
		provider.stop("stopped");
		expect(cancels).toEqual([]);
		// And the turn after it is untouched.
		expect((await provider.run(context().ctx)).stopReason).toBe("empty");
	});

	it("does not run a turn for somebody who already left", async () => {
		const controller = new AbortController();
		controller.abort();
		const { provider } = connect({ waitForCancel: true });
		const product = await provider.run(context({ signal: controller.signal }).ctx);
		expect(product.stopReason).toBe("interrupted");
	});
});

describe("a connection that breaks", () => {
	it("is failed, with the message where a failure goes and not where a reply goes", async () => {
		const { provider } = connect({ explodes: "the agent hung up" });
		const product = await provider.run(context().ctx);

		expect(product.stopReason).toBe("failed");
		expect(product.answer).toBe("");
		expect(product.failure?.code).toBe("acp_transport");
		// What crosses the wire is the protocol's word, not the agent's. The SDK turns
		// an unhandled throw into a JSON-RPC internal error and does not leak the
		// message, which is the right call on their side and a real limit on ours:
		// **the reason an agent broke is not available to us through this path.**
		// Whatever arrives is carried through rather than replaced with a guess.
		expect(product.failure?.message.length).toBeGreaterThan(0);
	});
});

describe("all seven, end to end", () => {
	it("every stop reason in the vocabulary is reachable through this provider", async () => {
		const reached = new Set<string | undefined>();

		reached.add(
			(
				await connect({ says: [{ kind: "agent_message_chunk", text: "x" }] }).provider.run(
					context().ctx,
				)
			).stopReason,
		);
		reached.add((await connect({}).provider.run(context().ctx)).stopReason);
		reached.add(
			(await connect({ stopReason: "max_turn_requests" }).provider.run(context().ctx))
				.stopReason,
		);
		reached.add(
			(await connect({ stopReason: "refusal" }).provider.run(context().ctx)).stopReason,
		);
		reached.add((await connect({ explodes: "gone" }).provider.run(context().ctx)).stopReason);

		for (const cause of ["interrupted", "stopped"] as const) {
			const { provider } = connect({ waitForCancel: true });
			const running = provider.run(context().ctx);
			provider.stop(cause);
			reached.add((await running).stopReason);
		}

		expect([...reached].sort()).toEqual([
			"answered",
			"budget",
			"empty",
			"failed",
			"interrupted",
			"refused",
			"stopped",
		]);
	});
});
