/**
 * `AcpProvider`: a turn run by somebody else's agent, through the seam.
 *
 * This is the piece that ends the arrangement where the daemon spawns a vendor
 * binary and reads its output. That arrangement was not merely inelegant, it was
 * load-bearing for a missing feature: `claude -p` is launched with its input
 * ignored, so there is no channel to say anything to a persona once it is
 * working. Talking to a working persona was not unbuilt. It was **impossible**,
 * and no amount of front-end would have made it appear.
 *
 * ACP is JSON-RPC in both directions over a session that stays open. The turn
 * becomes a request, the interruption becomes a notification, and the agent's
 * permission questions come back to us as requests we answer. Forty agents speak
 * it. So the provider is the whole ecosystem arriving through one file, which is
 * the point the plan makes about closing distance by protocol rather than by
 * volume.
 *
 * ## It takes a connection, it does not make one
 *
 * The same call `default-provider.ts` makes about the agent, for the same reason:
 * who owns the lifetime is the caller's business, and a provider that opened its
 * own connection would quietly decide it. Here it matters more than there,
 * because the thing owning that lifetime is the daemon, which already knows which
 * directories were consented to and already kills its children on the way out.
 *
 * The consequence worth having is that the whole class tests over a pair of
 * in-memory streams against a scripted agent, with no process anywhere. Every one
 * of the seven stop reasons is reachable that way, which is what `A1` asks for.
 *
 * ## What it does not do, on purpose
 *
 * It does not decide permissions. `requestPermission` is where the compiled
 * policy will answer, and that is `A3`, deliberately a separate row: wiring the
 * gate in at the same time as the transport would make a failure in either look
 * like a failure in both. Until then the client handed in answers, and this file
 * has no opinion about how.
 *
 * It does not write the record. `A4` gives the agent's events their own author,
 * and the reason it is not here is that the collector below already keeps the
 * three kinds of content apart, which is the hard half. Attribution is the easy
 * half done in the right place, which is not inside a translator.
 */

import type { run } from "@personaxis/core";

import { type AcpTurnState, type CancelCause, failureOf, productOf } from "./translate.js";

/**
 * The part of an ACP agent connection a turn needs.
 *
 * Structurally satisfied by the SDK's `ClientSideConnection`, and named here as
 * two methods rather than imported as a class so that the provider depends on
 * what it uses. A test can hand it a script; the daemon hands it the real thing.
 */
export interface AcpAgentConnection {
	prompt(params: {
		sessionId: string;
		prompt: readonly { type: "text"; text: string }[];
		_meta?: Record<string, unknown>;
	}): Promise<{ stopReason: string; usage?: AcpUsage | null }>;
	cancel(params: { sessionId: string }): Promise<void>;
}

/**
 * What the agent reports spending.
 *
 * **Every number here is cumulative across the session**, which the schema says
 * plainly and which is the single most expensive thing to miss in this file:
 * `totalTokens` is "sum of all token types across session" and `inputTokens` is
 * "total input tokens across all turns". They arrive on the response to one
 * prompt, which is exactly where a per-turn figure would arrive, and they are not
 * one.
 *
 * `TurnProduct.cost` is per turn, and the runner charges the ledger with it. Had
 * this been passed through, turn ten would have been charged for what turns one
 * through ten spent between them, and a ten-turn session would have billed
 * roughly fifty-five times its tokens. Nothing would have looked wrong: the
 * numbers are real, they are just answers to a different question.
 *
 * So the provider keeps the running total and reports the difference. See
 * `deltaOf`.
 */
export interface AcpUsage {
	readonly totalTokens?: number | null;
	readonly inputTokens?: number | null;
	readonly outputTokens?: number | null;
}

/** Cumulative session cost, in whatever currency the agent bills in. */
export interface AcpCost {
	readonly amount?: number | null;
	readonly currency?: string | null;
}

/**
 * Gathers what arrives on `session/update` while a turn runs.
 *
 * A separate object because the notifications land on the `Client` the connection
 * was constructed with, which is built before any turn exists and outlives all of
 * them. Something has to hold the per-turn state, and a field on the provider
 * would be a field two turns could share.
 *
 * **The three kinds of content are kept apart here, and that is the whole job.**
 * `agent_message_chunk` is the answer. `agent_thought_chunk` is reasoning, and
 * `user_message_chunk` is our own prompt echoed back. They arrive interleaved on
 * one channel, and a collector that concatenated all three would produce a reply
 * containing the agent's thinking and our own question, attributed to the persona.
 * That is the ninth gap the study named, and it is cheaper to not create it than
 * to unpick it downstream.
 */
export class AcpTurnCollector {
	#text = "";
	#thoughts = "";
	#steps = 0;
	#seenToolCalls = new Set<string>();
	#sessionCost: AcpCost | undefined;
	#contextUsed: number | undefined;
	#contextSize: number | undefined;
	/** Called when a tool call is first seen, so the ledger can charge inside a turn. */
	onStep: (() => void) | undefined;

	/** Starts a turn. Called by the provider, never by the connection. */
	begin(onStep?: () => void): void {
		this.#text = "";
		this.#thoughts = "";
		this.#steps = 0;
		this.#seenToolCalls = new Set();
		this.onStep = onStep;
		// The session cost and the context window are deliberately NOT reset. They
		// describe the session, not the turn, and forgetting them between turns is
		// what would make the next difference wrong.
	}

	/** What the agent reasoned, kept but never returned as the answer. */
	get thoughts(): string {
		return this.#thoughts;
	}

	/**
	 * How full the agent's context window is, as of the last update.
	 *
	 * Not a cost and never charged as one. It is here because compaction needs it
	 * and because a number that already crosses the wire should not have to be
	 * asked for again.
	 */
	get context(): { readonly used?: number; readonly size?: number } {
		return {
			...(this.#contextUsed === undefined ? {} : { used: this.#contextUsed }),
			...(this.#contextSize === undefined ? {} : { size: this.#contextSize }),
		};
	}

	/** Cumulative session cost as last reported. The provider takes the difference. */
	get sessionCost(): AcpCost | undefined {
		return this.#sessionCost;
	}

	snapshot(cancelCause?: CancelCause): AcpTurnState {
		return {
			text: this.#text,
			steps: this.#steps,
			...(cancelCause === undefined ? {} : { cancelCause }),
		};
	}

	/**
	 * Hand this straight to the SDK's `Client.sessionUpdate`.
	 *
	 * Unknown update kinds are ignored rather than rejected. The protocol adds
	 * them between versions, and a client that threw on a word it did not know
	 * would break a turn over a notification it had no need to read.
	 */
	sessionUpdate(params: { update: Record<string, unknown> }): void {
		const update = params.update;
		const kind = update["sessionUpdate"];

		if (kind === "agent_message_chunk") {
			this.#text += textOf(update["content"]);
			return;
		}
		if (kind === "agent_thought_chunk") {
			this.#thoughts += textOf(update["content"]);
			return;
		}
		if (kind === "tool_call") {
			// Counted once per call, by id. `tool_call_update` reports the same call
			// changing state, and counting those would charge a turn for how chatty
			// the agent is about one action rather than for the action.
			const id = String(update["toolCallId"] ?? "");
			if (id !== "" && this.#seenToolCalls.has(id)) return;
			if (id !== "") this.#seenToolCalls.add(id);
			this.#steps += 1;
			this.onStep?.();
			return;
		}
		if (kind === "usage_update") {
			// `used` and `size` are the context window, not the spend. The only money
			// on this notification is `cost`, and it is cumulative for the session.
			if (typeof update["used"] === "number") this.#contextUsed = update["used"];
			if (typeof update["size"] === "number") this.#contextSize = update["size"];
			const cost = update["cost"];
			if (cost !== null && typeof cost === "object") this.#sessionCost = cost as AcpCost;
		}
	}
}

/** Content blocks carry text under `text`; anything else contributes nothing. */
function textOf(content: unknown): string {
	if (content === null || typeof content !== "object") return "";
	const block = content as { type?: unknown; text?: unknown };
	if (block.type !== "text") return "";
	return typeof block.text === "string" ? block.text : "";
}

/** The session total the agent last reported, or nothing when it reports none. */
function totalTokensOf(usage: AcpUsage | null | undefined): number | undefined {
	if (usage === null || usage === undefined) return undefined;
	if (typeof usage.totalTokens === "number") return usage.totalTokens;
	const input = typeof usage.inputTokens === "number" ? usage.inputTokens : undefined;
	const output = typeof usage.outputTokens === "number" ? usage.outputTokens : undefined;
	if (input === undefined && output === undefined) return undefined;
	return (input ?? 0) + (output ?? 0);
}

/**
 * This turn's share of a running total.
 *
 * A counter that went backwards has been reset, and what it reads now is what has
 * been spent since. Treating that as a negative charge would credit the tenant for
 * an agent restarting.
 */
export function deltaOf(previous: number, current: number): number {
	const difference = current - previous;
	return difference < 0 ? current : difference;
}

/**
 * Money, and only when it is the currency the field claims.
 *
 * `TurnProduct.cost.usd` is dollars by its name. An agent billing in euros
 * reporting `amount: 4` would put four euros into a field everything downstream
 * adds up as dollars, and a converted figure would be worse, because the rate
 * would be invented here. Anything that is not USD contributes nothing, and the
 * tokens still come through.
 */
function usdOf(cost: AcpCost | undefined): number | undefined {
	if (cost === undefined) return undefined;
	if (cost.currency !== "USD") return undefined;
	return typeof cost.amount === "number" ? cost.amount : undefined;
}

export interface AcpProviderOptions {
	/** The open connection. Owned by the caller. */
	readonly connection: AcpAgentConnection;
	/** The session the caller already created with `session/new`. */
	readonly sessionId: string;
	/** The collector wired into the same connection's `Client`. */
	readonly collector: AcpTurnCollector;
	/** Names the agent in the record. `claude-code`, `gemini-cli`, and so on. */
	readonly agentName?: string;
	/**
	 * Metadata for every turn, on the protocol's own `_meta`.
	 *
	 * ACP reserves that field for exactly this and says implementations must make no
	 * assumptions about keys in it, which is why what goes there is namespaced by
	 * whoever puts it. An agent that does not know the key ignores it, and one built
	 * against us reads a fact it would otherwise have to find in a sentence.
	 */
	readonly meta?: Record<string, unknown>;
}

/**
 * A loop provider with one extra thing on it: a way to stop the turn and say why.
 *
 * The extra method exists because ACP's `cancelled` cannot carry a reason and
 * ours must. Two of our four cancel causes are things the provider notices for
 * itself, a ceiling and an abort. The other two, an operator's rule firing and a
 * guard refusing, are noticed by somebody else, and without a way in they would
 * be stop reasons that exist in the vocabulary and can never be produced.
 *
 * It is also the beginning of what `A6` calls the single stop route. Today there
 * are two, one that works and one that only writes an event.
 */
export interface AcpProvider extends run.LoopProvider {
	/**
	 * Ends the turn in progress, recording which of our reasons it was.
	 *
	 * Does nothing between turns, which is the honest behaviour rather than an
	 * omission: there is nothing to cancel, and remembering the request in order
	 * to apply it to whatever runs next would stop a turn the caller never saw.
	 */
	stop(cause: CancelCause): void;
}

/**
 * The provider.
 *
 * Everything hard about this file is in what it refuses to do on the way through:
 * it does not close the turn, it does not write the record, and it does not
 * charge the ledger, because the runner does all three on every path and a
 * provider that helped would be a second place those things could happen.
 */
export function acpLoop(options: AcpProviderOptions): AcpProvider {
	const { connection, sessionId, collector } = options;
	const name = "acp:" + (options.agentName ?? "agent");

	/** Set while a turn is in flight, so `stop` has something to reach. */
	let cancelCurrentTurn: ((cause: CancelCause) => void) | undefined;

	/** What the session had spent before the turn now running. See `AcpUsage`. */
	let tokensBefore = 0;
	let usdBefore = 0;

	return {
		name,
		stop: (cause: CancelCause): void => cancelCurrentTurn?.(cause),
		run: async (context: run.TurnContext): Promise<run.TurnProduct> => {
			/**
			 * Why we cancelled, if we did.
			 *
			 * Set before the cancel goes out and read after the agent answers.
			 * `cancelled` on the wire cannot say which of our four reasons it was,
			 * and this variable is the only thing that can. See `translate.ts`.
			 */
			let cancelCause: CancelCause | undefined;

			/** Cancelling twice is not an error, but sending twice is noise. */
			let cancelSent = false;
			const cancelWith = (cause: CancelCause): void => {
				if (cancelSent) return;
				cancelSent = true;
				cancelCause = cause;
				// Deliberately not awaited. The specification says the agent answers
				// the outstanding `prompt` with `cancelled`, so the turn's own promise
				// is what we are waiting on; awaiting the notification as well would
				// add a second thing that can hang to a path taken because something
				// already needed to stop.
				void connection.cancel({ sessionId }).catch(() => {
					// A cancel that cannot be delivered leaves the prompt to settle on
					// its own. Rethrowing here would replace whatever actually ended the
					// turn with a transport error about our attempt to end it.
				});
			};

			// A step landing is when the ledger can be asked, because that is when a
			// number changed. Asking before the turn starts answers about the turn
			// that already ran.
			collector.begin(() => {
				context.stepDone();
				if (!context.hasRoom()) cancelWith("budget");
			});

			const onAbort = (): void => cancelWith("interrupted");
			context.signal?.addEventListener("abort", onAbort, { once: true });
			cancelCurrentTurn = cancelWith;

			try {
				// Started, not awaited, so that a cancel can follow it on the same
				// stream. Ordering is what makes this work: a cancel sent before the
				// prompt would reach an agent with no turn to cancel, which the agent
				// is entitled to ignore, and the turn would then run to completion for
				// somebody who had already left.
				const pending = connection.prompt({
					sessionId,
					prompt: [{ type: "text", text: context.request.prompt }],
					...(options.meta === undefined ? {} : { _meta: options.meta }),
				});

				// Already aborted before the turn began is a real case: a person who
				// pressed stop while the previous turn was closing.
				if (context.signal?.aborted === true) cancelWith("interrupted");

				const response = await pending;
				const state = collector.snapshot(cancelCause);
				const product = productOf(response.stopReason, state);

				// Both figures are session totals, so this turn's cost is what they grew
				// by. The header of `AcpUsage` says what happens without this.
				const tokensNow = totalTokensOf(response.usage);
				const usdNow = usdOf(collector.sessionCost);
				if (tokensNow === undefined && usdNow === undefined) return product;

				const cost = {
					tokens: tokensNow === undefined ? 0 : deltaOf(tokensBefore, tokensNow),
					usd: usdNow === undefined ? 0 : deltaOf(usdBefore, usdNow),
				};
				if (tokensNow !== undefined) tokensBefore = tokensNow;
				if (usdNow !== undefined) usdBefore = usdNow;

				return { ...product, cost };
			} catch (error) {
				// The connection died, the agent went away, or the request came back an
				// error. None of those is a stop reason to translate, so the turn is
				// `failed` with the message carried through rather than shown as a reply.
				const message = error instanceof Error ? error.message : String(error);
				return failureOf("acp_transport", message, collector.snapshot(cancelCause));
			} finally {
				context.signal?.removeEventListener("abort", onAbort);
				collector.onStep = undefined;
				// Cleared so a `stop` arriving between turns reaches nothing rather
				// than cancelling whichever turn happens to start next.
				cancelCurrentTurn = undefined;
			}
		},
	};
}
