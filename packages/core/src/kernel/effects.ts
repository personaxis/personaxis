/**
 * Undoing exactly what was done, in the opposite order.
 *
 * Every registration a component makes hands back the way to undo it, and the
 * component never keeps that undo itself: it goes into the scope it was created
 * in. That inversion is the point. A component that owned its own cleanup would
 * have to remember to run all of it on every failure path, and the failure paths
 * are where nobody remembers.
 *
 * ## Reverse order is not a detail
 *
 * Effects are unwound newest first because later effects were built on earlier
 * ones. A listener registered after a service was provided may fire while that
 * service is being torn down; unwinding forward would tear down the service first
 * and leave the listener holding a reference to something already gone.
 *
 * ## Registering during an unwind is an error with its own name
 *
 * A disposer that registers a new effect is asking the scope to grow while it is
 * shrinking, which either loops or silently leaks depending on how the loop is
 * written. Both are worse than refusing. It gets its own code, `effect_after_unwind`,
 * because a component author reading a generic error will assume they hit a bug in
 * the kernel rather than in their own teardown.
 *
 * ## A disposer that throws does not stop the unwind
 *
 * The remaining effects still run, and the failures come back as a list. The
 * alternative, stopping at the first throw, leaves an arbitrary suffix of the scope
 * mounted with nothing tracking it, which is the leak the whole mechanism exists to
 * prevent. What we refuse to do is swallow them: they are returned so the caller
 * can put them in the record.
 */

import { type RecordableFailure, recordable } from "./errors.js";
import { KernelError } from "./errors.js";

/** The one thing an effect is: a way to undo itself. */
export type Disposer = () => void;

/**
 * A place to put undos, which knows how to run them.
 *
 * Scopes nest. A child scope is itself an effect of its parent, so unwinding a
 * parent unwinds every descendant, newest first, all the way down. That is how a
 * component's own effects and the effects of anything it mounted come apart in one
 * call without a registry of who owns what.
 */
export class EffectScope {
	private readonly disposers: Disposer[] = [];
	private state: "open" | "unwinding" | "closed" = "open";

	/** What this scope is for, so a failure can say where it happened. */
	constructor(readonly label: string) {}

	/** True once the scope has finished unwinding. A closed scope accepts nothing. */
	get closed(): boolean {
		return this.state === "closed";
	}

	/**
	 * Records an undo.
	 *
	 * Returns the same disposer so a caller can hold it for an early, targeted undo,
	 * which is normal: a component that stops needing one of its own registrations
	 * before it is disposed should be able to say so. Running it early and again at
	 * unwind is safe as long as the disposer is idempotent, and `once` below makes
	 * any disposer idempotent.
	 */
	use(dispose: Disposer): Disposer {
		if (this.state !== "open") {
			throw new KernelError(
				"effect_after_unwind",
				`the scope "${this.label}" is ${this.state}, so it cannot take another effect. ` +
					"A disposer that registers new effects makes teardown unbounded.",
				{ subject: this.label },
			);
		}
		this.disposers.push(dispose);
		return dispose;
	}

	/**
	 * Opens a scope whose lifetime is inside this one.
	 *
	 * The child is registered as an effect of the parent before it is returned, so
	 * there is no window in which a child exists and nothing would tear it down.
	 */
	child(label: string): EffectScope {
		const scope = new EffectScope(label);
		this.use(() => {
			scope.unwind();
		});
		return scope;
	}

	/**
	 * Runs every undo, newest first, and returns whatever failed.
	 *
	 * Calling it twice is a no-op rather than an error. Teardown races are ordinary
	 * (a component disposed while its parent is unwinding), and making the second
	 * call throw would turn a benign race into a failure somebody has to handle.
	 */
	unwind(): RecordableFailure[] {
		if (this.state !== "open") return [];
		this.state = "unwinding";
		const failures: RecordableFailure[] = [];
		for (let index = this.disposers.length - 1; index >= 0; index -= 1) {
			try {
				this.disposers[index]!();
			} catch (thrown) {
				const failure = recordable(thrown, this.label);
				failures.push(
					failure.code === "unknown"
						? { ...failure, code: "disposal_failed" }
						: failure,
				);
			}
		}
		this.disposers.length = 0;
		this.state = "closed";
		return failures;
	}
}

/**
 * Makes a disposer safe to call more than once.
 *
 * Useful because the same undo is often reachable two ways: directly, by whoever
 * kept it, and through the scope at teardown. Without this the second call runs the
 * body again, and a body that removes an entry from a map is fine twice while one
 * that decrements a counter is not.
 */
export function once(dispose: Disposer): Disposer {
	let done = false;
	return () => {
		if (done) return;
		done = true;
		dispose();
	};
}
