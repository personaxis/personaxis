/**
 * The loop as a seam, with our provider as the default one.
 *
 * A customer who can plug in their own loop is the difference between a platform and a
 * product, and it costs almost nothing to have it that way now rather than to retrofit
 * it later. Three roles, the same split as every other capability: a definition, a
 * default provider, and consumers that never import the provider.
 *
 * ## The provider cannot skip the close, because it never performs the close
 *
 * This is the correction to the thing the reference gets wrong. Its contract says a
 * delivered answer must close the durable turn, and twenty-five early returns skip the
 * function that does it, each replicating a subset of the cleanup by hand. Every one of
 * those was written by somebody who knew the rule.
 *
 * So the rule is not a rule here. A provider's job is to run a turn and return what it
 * produced, or throw. It has no access to the finaliser, no way to reach the record,
 * and no way to end a turn. **The runner closes every turn, on every path**, because
 * the runner is the only thing that can.
 *
 * A provider that returns without an answer is closed as `abandoned`, which is a
 * stop reason like any other rather than a silence. A provider that throws is closed as
 * `failed` with the code. A provider that never returns is somebody else's problem: a
 * deadline is a guard, and this file does not race promises, because racing one returns
 * control to the caller while the work carries on underneath.
 *
 * ## What the runner does that a provider must not have to remember
 *
 * Charge the ledger, write the open and the close, and make the close the only exit.
 * Everything else is the provider's.
 */

import { Ledger, describeRoom } from "./budget.js";
import type { StopReason, TurnOutcome, TurnRequest } from "./vocabulary.js";

/** What a provider is given. Deliberately small. */
export interface TurnContext {
	readonly request: TurnRequest;
	/**
	 * Whether there is room for another step.
	 *
	 * Truthful only if the provider also reports its steps as they finish, which is
	 * what `stepDone` is for. Without that the ledger learns the count at the end and
	 * this answers about a turn that has already spent whatever it spent.
	 */
	readonly hasRoom: () => boolean;
	/**
	 * Says a step came back, and charges for it.
	 *
	 * Reporting incrementally is what makes the ceiling bind **inside** a turn rather
	 * than only between turns. A provider that never calls it is still charged, at the
	 * end, for the total it reports; it just cannot be stopped partway.
	 *
	 * Like the deadline, this is cooperative and the header says so rather than
	 * implying otherwise: a provider that ignores `hasRoom` and keeps going is not
	 * stopped by the ledger. What the ledger guarantees is that the spend is counted
	 * against the tree and that the next turn is refused, which is the part a tenant
	 * ceiling actually rests on.
	 */
	readonly stepDone: () => void;
	/** Cancellation, cooperative. A provider that ignores it is not stopped by it. */
	readonly signal?: AbortSignal;
}

/** What a provider produced, before the runner turns it into an outcome. */
export interface TurnProduct {
	readonly answer: string;
	readonly steps: number;
	readonly stopReason?: Extract<StopReason, "answered" | "empty" | "interrupted" | "refused">;
}

/**
 * A loop.
 *
 * One method, because a seam with one operation is a seam somebody can implement in an
 * afternoon, and a seam nobody can implement is a seam that has one provider forever.
 */
export interface LoopProvider {
	readonly name: string;
	run(context: TurnContext): Promise<TurnProduct>;
}

/** What the runner tells the record. The runner does not write it itself. */
export interface TurnObserver {
	opened?(request: TurnRequest): void;
	/** Called exactly once per turn, on every path, including the ones nobody planned. */
	closed?(outcome: TurnOutcome): void;
}

export interface RunnerOptions {
	readonly provider: LoopProvider;
	readonly ledger?: Ledger;
	readonly observer?: TurnObserver;
}

/**
 * Runs turns through a provider, and owns every ending.
 *
 * Consumers hold one of these and never see the provider, which is what makes swapping
 * one a configuration change rather than a rewrite.
 */
export class TurnRunner {
	readonly ledger: Ledger;
	/**
	 * Genuinely private, with `#` rather than TypeScript's `private`.
	 *
	 * `private` is a compile-time courtesy and the field is there at runtime for
	 * anybody who looks. The claim here is that a consumer never sees the provider, and
	 * a claim worth making is worth making true rather than checked.
	 */
	readonly #provider: LoopProvider;
	readonly #observer: TurnObserver | undefined;

	constructor(options: RunnerOptions) {
		this.#provider = options.provider;
		this.ledger = options.ledger ?? new Ledger();
		this.#observer = options.observer;
	}

	/** Which loop is actually running, for a report. Consumers do not import it. */
	get providerName(): string {
		return this.#provider.name;
	}

	async run(request: TurnRequest, signal?: AbortSignal): Promise<TurnOutcome> {
		const room = this.ledger.room();
		if (!room.ok) {
			// Refused before the turn opens, so nothing is charged and nothing is
			// written as having started. A turn that was never allowed to begin is not a
			// turn that ended.
			return this.#close({
				turn: request.turn,
				stopReason: "budget",
				answer: "",
				steps: 0,
				failure: { code: "budget", message: describeRoom(room) },
			});
		}

		this.#observer?.opened?.(request);

		// Steps the provider reported as they finished, so the total at the end is not
		// charged twice for the ones already counted.
		let reported = 0;
		const context: TurnContext = {
			request,
			hasRoom: () => this.ledger.room().ok,
			stepDone: () => {
				reported += 1;
				this.ledger.chargeStep();
			},
			...(signal ? { signal } : {}),
		};

		let product: TurnProduct;
		try {
			product = await this.#provider.run(context);
		} catch (thrown) {
			const message = thrown instanceof Error ? thrown.message : String(thrown);
			// The turn still closes, and it closes reporting the steps that actually
			// happened. Reporting zero because the provider threw would charge the ledger
			// for work the outcome then denies took place, which is the same class of
			// divergence the record exists to make impossible: two numbers about one fact,
			// and nothing comparing them.
			return this.#close({
				turn: request.turn,
				stopReason: "failed",
				answer: "",
				steps: reported,
				failure: { code: "provider_failed", message },
			});
		}

		// Only what was not already charged. A provider that reported nothing pays for
		// everything here; one that reported as it went pays nothing extra.
		for (let index = reported; index < product.steps; index += 1) this.ledger.chargeStep();

		const stopReason: StopReason =
			product.stopReason ?? (product.answer.length > 0 ? "answered" : "abandoned");

		return this.#close({
			turn: request.turn,
			stopReason,
			answer: product.answer,
			steps: product.steps,
			...(stopReason === "abandoned"
				? {
						failure: {
							code: "abandoned",
							message: "the loop returned without an answer and without saying why",
						},
					}
				: {}),
		});
	}

	/**
	 * The one exit.
	 *
	 * Private, and the only thing that produces a `TurnOutcome`. A provider cannot call
	 * it because a provider does not have it, which is what turns "always close the
	 * turn" from a rule somebody follows into a shape of the code.
	 */
	#close(outcome: TurnOutcome): TurnOutcome {
		this.ledger.chargeTurn();
		this.#observer?.closed?.(outcome);
		return outcome;
	}
}
