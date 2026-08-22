/**
 * Events whose contract includes how they are dispatched.
 *
 * If everything is emitted the same way, a component that wants to prevent
 * something has no way to, and a component that only watches can block the system
 * by accident. So the mode is not a property of the call site, it is part of the
 * event's declaration, and there is exactly one dispatch function that reads the
 * mode off the declaration.
 *
 * That is the gate, and it is structural rather than a lint rule. The reference
 * kernel declares the mode in documentation and generates a check that the
 * dispatch site agrees. Ours cannot disagree: there is no way to spell a dispatch
 * that uses a different mode than the one the event declares, so the check has
 * nothing left to check. Making the wrong thing unrepresentable beats catching it.
 *
 * ## The four modes, and what each one is for
 *
 * **Waterfall.** The listener receives the payload and a `next`, and may transform
 * it, wrap it, recover from a failure, or refuse to call `next` at all. Delegating
 * is cooperating; not delegating is deciding. This is the mode of decision points:
 * before a step, before a tool runs, while assembling a prompt.
 *
 * **Serial.** Awaited, in registration order, for ordered checkpoints.
 *
 * **Parallel.** Awaited fanned out, for when every listener has to get its chance
 * independently of the others. The durability point at the end of a turn is the
 * example: if one writer fails, the others still have to write.
 *
 * **Notify.** Synchronous, no return value, for what is only being counted.
 *
 * ## A thrown listener means different things in different modes
 *
 * In notify and parallel a listener's failure is contained: those modes exist for
 * observers, and an observer that breaks must not take down the thing it observes.
 * The failures come back so they can be recorded rather than swallowed.
 *
 * In a waterfall it is not contained, and that asymmetry is deliberate. A waterfall
 * is a decision point. A listener that threw halfway did not decide, and continuing
 * as though the chain had completed turns a crash into a silent allow. Failing the
 * dispatch is the fail-closed reading, and it is the only one compatible with using
 * this mode for a gate.
 *
 * ## What does not travel on the bus
 *
 * The record does not. An event is a notification that something happened; the
 * record is the thing that happened. Routing the record through a bus would make an
 * entry's existence depend on whether a listener was registered, and the whole
 * value of a chained record is that its entries do not depend on who was watching.
 */

import { type RecordableFailure, asKernelError, recordable } from "./errors.js";
import type { EffectScope } from "./effects.js";
import { once } from "./effects.js";

/** How an event is dispatched. Declared with the event, never chosen at the call site. */
export type DispatchMode = "waterfall" | "serial" | "parallel" | "notify";

/**
 * An event's declaration.
 *
 * Declare one per event at module scope and export it. The declaration is the only
 * thing a publisher and a subscriber share, which is what keeps them from importing
 * each other.
 *
 * `recorded` is ours and not theirs: an extension point that can change what
 * happens leaves a trace. A waterfall listener that refused to delegate decided
 * something, and a decision nobody can see afterwards is the kind of thing an audit
 * asks about. The kernel does not write the record itself, it reports; what it
 * refuses to allow is a silent decision point.
 */
export interface EventDecl<Payload, Result = void> {
	readonly name: string;
	readonly mode: DispatchMode;
	/** Whether a listener's participation in this event belongs in the record. */
	readonly recorded: boolean;
	/**
	 * Phantoms, so the type parameters are used and inferred.
	 *
	 * Two optional properties rather than one function signature. A function would
	 * make the declaration contravariant in its payload, so a concrete event could
	 * not be passed to the internal helpers that take any event, and every call site
	 * would need a cast. Properties are covariant, and a cast at every mode check is
	 * exactly where a mode check stops being trustworthy.
	 */
	readonly __payload?: Payload;
	readonly __result?: Result;
}

/** Declares an event. The mode is fixed here and nowhere else. */
export function event<Payload, Result = void>(
	name: string,
	mode: DispatchMode,
	options?: { recorded?: boolean },
): EventDecl<Payload, Result> {
	return { name, mode, recorded: options?.recorded ?? mode === "waterfall" };
}

/** A waterfall listener: transform, wrap, recover, or decide by not calling `next`. */
export type WaterfallListener<Payload, Result> = (
	payload: Payload,
	next: (payload: Payload) => Promise<Result>,
) => Promise<Result>;

/** A serial or parallel listener. Awaited; its return value is discarded. */
export type AwaitedListener<Payload> = (payload: Payload) => Promise<void> | void;

/** A notify listener. Synchronous, and nothing waits for it. */
export type NotifyListener<Payload> = (payload: Payload) => void;

type AnyListener = (...args: never[]) => unknown;

interface Registration {
	readonly listener: AnyListener;
	readonly owner: string;
}

/**
 * What a dispatch produced.
 *
 * Failures are a list rather than a throw for the contained modes, so a caller can
 * put them in the record and carry on. For a waterfall the dispatch throws instead,
 * because there is no result to carry on with.
 */
export interface DispatchReport {
	readonly event: string;
	readonly listeners: number;
	readonly failures: readonly RecordableFailure[];
}

/**
 * The bus.
 *
 * Subscriptions are effects. A component that subscribes inside its own scope is
 * unsubscribed when that scope unwinds, which is what stops a reloaded component
 * from listening twice, the leak that makes a hot-reloading kernel emit duplicates
 * until somebody restarts the process.
 */
export class EventBus {
	private readonly registrations = new Map<string, Registration[]>();

	/**
	 * Subscribes to a waterfall event.
	 *
	 * Order is registration order, outermost first: the first listener registered
	 * wraps everything registered after it.
	 */
	onWaterfall<Payload, Result>(
		decl: EventDecl<Payload, Result>,
		owner: string,
		listener: WaterfallListener<Payload, Result>,
		scope?: EffectScope,
	): () => void {
		return this.add(decl, "waterfall", owner, listener as AnyListener, scope);
	}

	/** Subscribes to a serial or parallel event. */
	onAwaited<Payload>(
		decl: EventDecl<Payload, void>,
		owner: string,
		listener: AwaitedListener<Payload>,
		scope?: EffectScope,
	): () => void {
		if (decl.mode !== "serial" && decl.mode !== "parallel") {
			throw asKernelError(
				new Error(
					`"${decl.name}" is declared ${decl.mode}, so it cannot take an awaited listener`,
				),
				decl.name,
			);
		}
		return this.add(decl, decl.mode, owner, listener as AnyListener, scope);
	}

	/** Subscribes to a notify event. */
	onNotify<Payload>(
		decl: EventDecl<Payload, void>,
		owner: string,
		listener: NotifyListener<Payload>,
		scope?: EffectScope,
	): () => void {
		return this.add(decl, "notify", owner, listener as AnyListener, scope);
	}

	private add(
		decl: EventDecl<unknown, unknown>,
		expected: DispatchMode,
		owner: string,
		listener: AnyListener,
		scope?: EffectScope,
	): () => void {
		if (decl.mode !== expected) {
			throw asKernelError(
				new Error(
					`"${decl.name}" is declared ${decl.mode} and was subscribed to as ${expected}. ` +
						"The mode belongs to the event, not to the subscriber.",
				),
				decl.name,
			);
		}
		const list = this.registrations.get(decl.name) ?? [];
		const registration: Registration = { listener, owner };
		list.push(registration);
		this.registrations.set(decl.name, list);

		const remove = once(() => {
			const current = this.registrations.get(decl.name);
			if (!current) return;
			const at = current.indexOf(registration);
			if (at >= 0) current.splice(at, 1);
			if (current.length === 0) this.registrations.delete(decl.name);
		});
		scope?.use(remove);
		return remove;
	}

	/** How many listeners an event has. For diagnostics and for tests, not for logic. */
	countFor(decl: EventDecl<unknown, unknown>): number {
		return this.registrations.get(decl.name)?.length ?? 0;
	}

	/**
	 * Runs a waterfall and returns what came out.
	 *
	 * `terminal` is what happens when every listener delegated: the real work. A
	 * listener that does not call `next` prevents it, which is what "not delegating
	 * is deciding" means in one line of behaviour.
	 *
	 * A listener that throws fails the whole dispatch, on purpose. See the header.
	 */
	async waterfall<Payload, Result>(
		decl: EventDecl<Payload, Result>,
		payload: Payload,
		terminal: (payload: Payload) => Promise<Result>,
	): Promise<Result> {
		this.assertMode(decl, "waterfall");
		const chain = [...(this.registrations.get(decl.name) ?? [])];

		const step = async (index: number, current: Payload): Promise<Result> => {
			if (index >= chain.length) return terminal(current);
			const registration = chain[index]!;
			const listener = registration.listener as unknown as WaterfallListener<Payload, Result>;
			try {
				return await listener(current, (nextPayload) => step(index + 1, nextPayload));
			} catch (thrown) {
				const failure = asKernelError(thrown, `${decl.name} <- ${registration.owner}`);
				if (failure.code === "unknown") {
					throw Object.assign(failure, { code: "listener_failed" as const });
				}
				throw failure;
			}
		};

		return step(0, payload);
	}

	/** Runs listeners one at a time, in registration order. Failures are contained. */
	async serial<Payload>(
		decl: EventDecl<Payload, void>,
		payload: Payload,
	): Promise<DispatchReport> {
		this.assertMode(decl, "serial");
		const chain = [...(this.registrations.get(decl.name) ?? [])];
		const failures: RecordableFailure[] = [];
		for (const registration of chain) {
			try {
				await (registration.listener as unknown as AwaitedListener<Payload>)(payload);
			} catch (thrown) {
				failures.push(recordable(thrown, `${decl.name} <- ${registration.owner}`));
			}
		}
		return { event: decl.name, listeners: chain.length, failures };
	}

	/**
	 * Runs every listener at once and waits for all of them.
	 *
	 * Every listener gets its chance regardless of what the others did, which is the
	 * whole reason this mode exists. One writer failing at a durability point must
	 * not stop the others from writing.
	 */
	async parallel<Payload>(
		decl: EventDecl<Payload, void>,
		payload: Payload,
	): Promise<DispatchReport> {
		this.assertMode(decl, "parallel");
		const chain = [...(this.registrations.get(decl.name) ?? [])];
		const settled = await Promise.allSettled(
			chain.map(async (registration) =>
				(registration.listener as unknown as AwaitedListener<Payload>)(payload),
			),
		);
		const failures: RecordableFailure[] = [];
		settled.forEach((outcome, index) => {
			if (outcome.status === "rejected") {
				failures.push(recordable(outcome.reason, `${decl.name} <- ${chain[index]!.owner}`));
			}
		});
		return { event: decl.name, listeners: chain.length, failures };
	}

	/** Tells everyone, synchronously, and waits for nobody. Failures are contained. */
	notify<Payload>(decl: EventDecl<Payload, void>, payload: Payload): DispatchReport {
		this.assertMode(decl, "notify");
		const chain = [...(this.registrations.get(decl.name) ?? [])];
		const failures: RecordableFailure[] = [];
		for (const registration of chain) {
			try {
				(registration.listener as unknown as NotifyListener<Payload>)(payload);
			} catch (thrown) {
				failures.push(recordable(thrown, `${decl.name} <- ${registration.owner}`));
			}
		}
		return { event: decl.name, listeners: chain.length, failures };
	}

	private assertMode(decl: EventDecl<unknown, unknown>, expected: DispatchMode): void {
		if (decl.mode === expected) return;
		throw asKernelError(
			new Error(
				`"${decl.name}" is declared ${decl.mode} and was dispatched as ${expected}. ` +
					"The declaration is the contract.",
			),
			decl.name,
		);
	}
}
