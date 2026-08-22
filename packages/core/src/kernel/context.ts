/**
 * The context: who provides what, who needs what, and what happens when that changes.
 *
 * A component never imports another component. It declares the keys it needs and
 * the permissions it requires, and the kernel hands it a context that can answer
 * those and nothing else. Everything below exists to make that declaration mean
 * something at runtime.
 *
 * ## The epoch, which is the good idea we took whole
 *
 * A component's dependencies collapse to one string: the ids of what it asked for,
 * paired with the identity of whatever answered. That string is its epoch.
 *
 *   - Something it needs is missing  ->  no epoch  ->  the component is pending.
 *   - The epoch changes              ->  a different provider answered  ->  reload.
 *   - The epoch is unchanged         ->  nothing to do, however much churned around it.
 *
 * One comparison replaces a graph walk, and more importantly it replaces the class
 * of bug where a component keeps running against a provider that was replaced under
 * it. The epoch is **derived and never stored**: it is recomputed from what the
 * context holds right now, so it cannot go stale in the way a cached dependency
 * list does.
 *
 * ## Pending is a state, not a failure
 *
 * A component whose service is not there yet is inactive and waiting, not broken.
 * Order of mounting stops mattering, which is what kills the hand-written startup
 * sequence that every runtime accumulates and nobody dares reorder.
 *
 * ## Pending on a permission, which is ours
 *
 * The same mechanism carries the second axis. A component may require permissions,
 * and a permission is answered about a subject. Withdrawing one recomputes epochs
 * and suspends exactly the components that depended on it, with their effects
 * unwound in reverse, while everything else keeps running. No restart, and no
 * second invalidation path to keep in agreement with the first.
 *
 * This is why the reference kernel's availability predicate does not survive
 * contact with us. Theirs asks "is this usable"; a probe answering no for a moment
 * removes a capability from whatever happened to be starting. Ours asks "is this
 * allowed, for this subject", and the answer is a verdict from a source that is
 * itself a service, so replacing the source is an ordinary epoch change.
 *
 * ## Mounting and unmounting are facts, not bookkeeping
 *
 * A kernel that unmounts correctly is a correct kernel. One that reports every
 * mount and unmount lets somebody answer what this agent could reach on Tuesday at
 * three, which is the question an auditor asks and which no harness answers today.
 * The kernel does not write the record itself, that is a later phase; it emits, and
 * refuses to make a lifecycle change that nothing could observe.
 */

import { KernelError, type RecordableFailure, asKernelError, recordable } from "./errors.js";
import { EffectScope } from "./effects.js";
import { EventBus, event } from "./bus.js";
import {
	PERMISSIONS,
	type PermissionKey,
	type PermissionSource,
	type PermissionVerdict,
	type ServiceKey,
} from "./keys.js";

/** What a component is doing right now. */
export type ComponentState =
	/** Waiting for a service or a permission that is not there. Not an error. */
	| "pending"
	/** Resolved and running. */
	| "active"
	/** It was active and something it needed went away. Its effects are unwound. */
	| "suspended"
	/** Its activation threw. Its partial effects were unwound. It will retry on change. */
	| "failed";

/** What a component sees. Deliberately smaller than the context itself. */
export interface ComponentContext {
	/** The value behind a key it declared. Throws for a key it did not declare. */
	get<T>(key: ServiceKey<T>): T;
	/** The value behind a key it did not declare, or undefined. For genuinely optional use. */
	peek<T>(key: ServiceKey<T>): T | undefined;
	/** The bus. Subscriptions made through this are already scoped to the component. */
	readonly bus: EventBus;
	/** Where this component's effects go. Unwound on suspend, reload and unmount. */
	readonly scope: EffectScope;
	/** This component's name, so a failure it raises can say who raised it. */
	readonly name: string;
}

/**
 * A unit the kernel can mount.
 *
 * `activate` runs when everything it declared is available. It may return a
 * disposer, but it does not have to: anything it registered through its scope is
 * already tracked, and the return value is for the odd effect that has no other
 * home.
 */
export interface Component {
	readonly name: string;
	readonly needs?: readonly ServiceKey<unknown>[];
	readonly requires?: readonly PermissionKey[];
	activate(context: ComponentContext): void | (() => void);
}

/** What the kernel reports when a component's lifecycle changes. */
export interface LifecycleEvent {
	readonly component: string;
	readonly from: ComponentState;
	readonly to: ComponentState;
	/** The epoch it resolved to, when it has one. This is the auditable part. */
	readonly epoch?: string;
	/** Why, when the reason is not obvious from the transition. */
	readonly reason?: string;
	readonly failure?: RecordableFailure;
}

/**
 * Every lifecycle change, as it happens.
 *
 * Notify because a listener must not be able to delay or veto a mount: an observer
 * that can block the thing it observes is the mechanism, not an observer. And
 * `recorded` because this is precisely the fact worth chaining.
 */
export const LIFECYCLE = event<LifecycleEvent>("kernel.lifecycle", "notify", { recorded: true });

interface Mounted {
	readonly component: Component;
	state: ComponentState;
	epoch: string | undefined;
	scope: EffectScope | undefined;
	failure: RecordableFailure | undefined;
	/**
	 * What was last said about this component, so a change nobody would otherwise
	 * see still gets reported.
	 *
	 * A component that mounts and stays pending never changes state, so a
	 * state-only comparison says nothing happened and the reason it is waiting is
	 * lost. That reason is the single most useful thing about a pending component:
	 * without it somebody reads "pending" and goes looking through every provider
	 * in the process. So arrival is reported, and so is a pending component that
	 * starts waiting for something different than it was waiting for before.
	 */
	reported: string | undefined;
}

/** Why a component cannot resolve right now. Both cases name themselves. */
type Unresolved =
	| { kind: "service_absent"; subject: string }
	| { kind: "permission_absent"; subject: string }
	| { kind: "permission_denied"; subject: string; reason: string };

export class Kernel {
	readonly bus = new EventBus();

	/** Provided values, and a counter per key so replacing a provider changes the epoch. */
	private readonly services = new Map<string, { value: unknown; generation: number }>();
	private generation = 0;

	private readonly mounted: Mounted[] = [];

	/** True while a settle pass is running, so a change made during one folds into it. */
	private settling = false;
	private dirty = false;

	/**
	 * Whether the kernel still accepts work.
	 *
	 * Shutdown needs this because tearing a component down runs its disposers, and a
	 * component that provided a key registered the removal of that key as one of
	 * them. Removing a key normally triggers a settle, and a settle during shutdown
	 * walks a list that is still half populated: it would re-activate a component
	 * that was already torn down, whose entry is then dropped, leaving whatever that
	 * component provided registered forever with nothing left that could unwind it.
	 *
	 * Found by the property that says shutdown leaves no key provided, which is
	 * exactly the kind of thing a hand-written test does not think to check.
	 */
	private phase: "open" | "closing" | "closed" = "open";

	/**
	 * Registers a value under a key, and hands back the way to take it away again.
	 *
	 * Providing is an effect like any other. Taking it away is what makes a component
	 * that depended on it suspend, so a test can exercise the suspension path without
	 * simulating a crash.
	 *
	 * A second provider for the same key fails loud. Last-wins would make the winner
	 * depend on module import order, which is the kind of thing that behaves one way
	 * on a developer's machine and another in a bundle.
	 */
	provide<T>(key: ServiceKey<T>, value: T): () => void {
		this.assertOpen(`provide "${key.id}"`);
		if (this.services.has(key.id)) {
			throw new KernelError(
				"service_duplicate",
				`"${key.id}" already has a provider. Two providers for one key means the winner ` +
					"depends on import order, which is not a decision anyone made.",
				{ subject: key.id },
			);
		}
		this.generation += 1;
		this.services.set(key.id, { value, generation: this.generation });
		this.settle();
		return () => {
			if (!this.services.has(key.id)) return;
			this.services.delete(key.id);
			this.settle();
		};
	}

	/**
	 * Replaces the provider for a key that already has one.
	 *
	 * Separate from `provide` because replacing is a different intention and should
	 * read like one at the call site. Everything whose epoch mentions this key
	 * reloads; everything else is untouched.
	 */
	replace<T>(key: ServiceKey<T>, value: T): () => void {
		this.services.delete(key.id);
		return this.provide(key, value);
	}

	/** Reads a key directly. For hosts wiring things up, not for components. */
	peek<T>(key: ServiceKey<T>): T | undefined {
		return this.services.get(key.id)?.value as T | undefined;
	}

	/**
	 * Adds a component and resolves it if it can be resolved.
	 *
	 * Returns the way to unmount it. Mounting in any order gives the same result,
	 * which is the property that makes a declared graph better than a written
	 * sequence, and which `kernel.property.test.ts` checks over random orders.
	 */
	mount(component: Component): () => void {
		this.assertOpen(`mount "${component.name}"`);
		if (this.mounted.some((entry) => entry.component.name === component.name)) {
			throw new KernelError(
				"service_duplicate",
				`a component named "${component.name}" is already mounted. Names are how a ` +
					"lifecycle entry says who moved, so two of them make the record ambiguous.",
				{ subject: component.name },
			);
		}
		const entry: Mounted = {
			component,
			state: "pending",
			epoch: undefined,
			scope: undefined,
			failure: undefined,
			reported: undefined,
		};
		this.mounted.push(entry);
		this.settle();
		return () => {
			const at = this.mounted.indexOf(entry);
			if (at < 0) return;
			this.mounted.splice(at, 1);
			this.deactivate(entry, "unmounted");
		};
	}

	/** What a component is doing, by name. For diagnostics and tests. */
	stateOf(name: string): ComponentState | undefined {
		return this.mounted.find((entry) => entry.component.name === name)?.state;
	}

	/** Its current epoch, when it has one. Derived, never stored anywhere durable. */
	epochOf(name: string): string | undefined {
		return this.mounted.find((entry) => entry.component.name === name)?.epoch;
	}

	/**
	 * Unwinds everything, newest component first, and reports what failed.
	 *
	 * Admission closes before the first disposer runs, so nothing a teardown does can
	 * bring a component back or register a key that would then have no owner. A
	 * disposer that tries gets a loud refusal, which the scope catches and reports
	 * rather than swallows: a teardown that quietly failed to tear down is the state
	 * this whole mechanism exists to make impossible.
	 */
	shutdown(): RecordableFailure[] {
		if (this.phase !== "open") return [];
		this.phase = "closing";
		const failures: RecordableFailure[] = [];
		for (let index = this.mounted.length - 1; index >= 0; index -= 1) {
			failures.push(...this.deactivate(this.mounted[index]!, "shutdown"));
		}
		this.mounted.length = 0;
		this.services.clear();
		this.phase = "closed";
		return failures;
	}

	private assertOpen(what: string): void {
		if (this.phase === "open") return;
		throw new KernelError(
			"effect_after_unwind",
			`the kernel is ${this.phase}, so it will not ${what}. Work registered during ` +
				"teardown has nothing left that could undo it.",
		);
	}

	/**
	 * Brings every component into agreement with what the context currently holds.
	 *
	 * Re-entrant on purpose. Activating a component often provides a service, which
	 * calls back into here; rather than recursing, the inner call marks the pass
	 * dirty and the outer loop goes round again. Recursing would make the number of
	 * open frames depend on how deep the dependency chain happens to be, and it would
	 * interleave two passes over the same list.
	 */
	private settle(): void {
		if (this.phase !== "open") return;
		if (this.settling) {
			this.dirty = true;
			return;
		}
		this.settling = true;
		try {
			let rounds = 0;
			do {
				this.dirty = false;
				rounds += 1;
				if (rounds > this.mounted.length + 2) {
					// Each round either resolves something new or changes nothing. More
					// rounds than components means something is oscillating, and a kernel
					// that spins is worse than one that stops and says so.
					throw new KernelError(
						"dependency_cycle",
						"components kept changing each other's resolution without settling. " +
							"Something provides a service whose own provider depends on it.",
					);
				}
				for (const entry of [...this.mounted]) this.reconcile(entry);
			} while (this.dirty);
		} finally {
			this.settling = false;
		}
	}

	private reconcile(entry: Mounted): void {
		const resolution = this.resolve(entry.component);

		if (!resolution.ok) {
			const why = describe(resolution.why);
			if (entry.state === "active") {
				// deactivate already reports the suspension, with the same reason.
				this.deactivate(entry, why);
			} else {
				// Covers three cases that read the same from outside: a component that
				// has just mounted, one that was already waiting for something else,
				// and one whose failed activation is now moot because what it needed
				// went away. All of them are waiting, and all of them owe a reason.
				this.transition(entry, entry.state === "suspended" ? "suspended" : "pending", why);
			}
			entry.epoch = undefined;
			return;
		}

		if (entry.state === "active" && entry.epoch === resolution.epoch) return;

		// Active with a different epoch means somebody replaced a provider underneath
		// it. Tearing down before building up keeps the two versions from coexisting,
		// which is what leaves two subscriptions on one bus.
		if (entry.state === "active") this.deactivate(entry, "epoch changed");

		this.activate(entry, resolution.epoch);
	}

	private activate(entry: Mounted, epoch: string): void {
		const scope = new EffectScope(entry.component.name);
		entry.scope = scope;
		const context = this.contextFor(entry.component, scope);
		try {
			const extra = entry.component.activate(context);
			if (typeof extra === "function") scope.use(extra);
		} catch (thrown) {
			// Its own effects come down before anything else happens. A component that
			// threw halfway has registered a prefix of what it meant to, and leaving
			// that prefix mounted is exactly the leak the scope exists to prevent.
			scope.unwind();
			entry.scope = undefined;
			entry.epoch = undefined;
			const failure = recordable(thrown, entry.component.name);
			entry.failure =
				failure.code === "unknown" ? { ...failure, code: "activation_failed" } : failure;
			this.transition(entry, "failed", "activation threw", entry.failure);
			return;
		}
		entry.epoch = epoch;
		entry.failure = undefined;
		this.transition(entry, "active", undefined, undefined, epoch);
	}

	private deactivate(entry: Mounted, reason: string): RecordableFailure[] {
		const failures = entry.scope?.unwind() ?? [];
		entry.scope = undefined;
		if (entry.state === "active") {
			this.transition(entry, "suspended", reason, failures[0]);
		}
		entry.epoch = undefined;
		return failures;
	}

	private transition(
		entry: Mounted,
		to: ComponentState,
		reason?: string,
		failure?: RecordableFailure,
		epoch?: string,
	): void {
		const from = entry.state;
		// The signature of what would be said, so an unchanged state with a changed
		// reason still gets said, and a repeated one does not.
		const signature = `${to}|${epoch ?? ""}|${reason ?? ""}|${failure?.code ?? ""}`;
		if (entry.reported === signature) return;
		entry.reported = signature;
		entry.state = to;
		this.bus.notify(LIFECYCLE, {
			component: entry.component.name,
			from,
			to,
			...(epoch === undefined ? {} : { epoch }),
			...(reason === undefined ? {} : { reason }),
			...(failure === undefined ? {} : { failure }),
		});
	}

	/**
	 * Works out whether a component can run, and what its epoch is if it can.
	 *
	 * The epoch pairs each id with the generation of whatever answered, so replacing
	 * a provider with a different value changes the string even when the key list is
	 * identical. Permissions contribute their verdict, so a re-grant after a
	 * withdrawal is a different epoch than the original grant, and the component
	 * reloads rather than silently resuming against state from before it was denied.
	 */
	private resolve(
		component: Component,
	): { ok: true; epoch: string } | { ok: false; why: Unresolved } {
		const parts: string[] = [];

		for (const key of component.needs ?? []) {
			const held = this.services.get(key.id);
			if (!held) return { ok: false, why: { kind: "service_absent", subject: key.id } };
			parts.push(`${key.id}@${held.generation}`);
		}

		const permissions = component.requires ?? [];
		if (permissions.length > 0) {
			const source = this.services.get(PERMISSIONS.id);
			if (!source) {
				return {
					ok: false,
					why: { kind: "permission_absent", subject: permissions[0]!.id },
				};
			}
			const answerer = source.value as PermissionSource;
			for (const permission of permissions) {
				let verdict: PermissionVerdict;
				try {
					verdict = answerer.answer(permission);
				} catch (thrown) {
					// A source that throws has not granted anything. Reading a failure as a
					// yes is the one reading that cannot be recovered from.
					verdict = {
						granted: false,
						reason: asKernelError(thrown, permission.id).message,
					};
				}
				if (!verdict.granted) {
					return {
						ok: false,
						why: {
							kind: "permission_denied",
							subject: permission.id,
							reason: verdict.reason,
						},
					};
				}
				parts.push(`${permission.id}!${source.generation}`);
			}
		}

		return { ok: true, epoch: parts.join("|") };
	}

	private contextFor(component: Component, scope: EffectScope): ComponentContext {
		const declared = new Set((component.needs ?? []).map((key) => key.id));
		const bus = this.bus;
		const services = this.services;
		return {
			name: component.name,
			scope,
			bus: scopedBus(bus, component.name, scope),
			get<T>(key: ServiceKey<T>): T {
				if (!declared.has(key.id)) {
					throw new KernelError(
						"service_absent",
						`"${component.name}" asked for "${key.id}" without declaring it. An ` +
							"undeclared read is invisible to the epoch, so replacing that " +
							"provider would leave this component running against the old one.",
						{ subject: key.id },
					);
				}
				return services.get(key.id)!.value as T;
			},
			peek<T>(key: ServiceKey<T>): T | undefined {
				return services.get(key.id)?.value as T | undefined;
			},
		};
	}
}

/**
 * A bus view that scopes every subscription to the component that made it and
 * stamps the owner without the caller having to remember either.
 *
 * Both halves matter. The scope is what stops a reloaded component listening
 * twice. The owner is what lets a contained failure say whose listener it was,
 * which is the difference between a report and a shrug.
 */
function scopedBus(bus: EventBus, owner: string, scope: EffectScope): EventBus {
	const view = Object.create(bus) as EventBus;
	const overrides = {
		onWaterfall: (decl: never, _owner: never, listener: never) =>
			bus.onWaterfall(decl, owner, listener, scope),
		onAwaited: (decl: never, _owner: never, listener: never) =>
			bus.onAwaited(decl, owner, listener, scope),
		onNotify: (decl: never, _owner: never, listener: never) =>
			bus.onNotify(decl, owner, listener, scope),
	};
	return Object.assign(view, overrides) as EventBus;
}

function describe(why: Unresolved): string {
	switch (why.kind) {
		case "service_absent":
			return `waiting for "${why.subject}"`;
		case "permission_absent":
			return `no permission source can answer "${why.subject}"`;
		case "permission_denied":
			return `"${why.subject}" denied: ${why.reason}`;
	}
}
