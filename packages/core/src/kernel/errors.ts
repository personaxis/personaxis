/**
 * What the kernel says when something goes wrong.
 *
 * A failure has two audiences and one of them does not read prose. The message is
 * for a person; the `code` is for the code that has to route it, and the two are
 * separate fields precisely so nobody branches on a substring of a sentence.
 * Substring matching is what people do when there is no code, and it breaks the
 * day somebody improves the wording.
 *
 * For us there is a third audience the reference runtimes do not have: the person
 * reading the record months later, who wants both at once. All three come out of
 * one entry and none is derived from another by parsing.
 *
 * ## Why the record makes this stricter than a convenience
 *
 * A failure that reaches an append-only chain without a code is an entry saying
 * something went wrong that cannot answer *what*. That is not a maintenance
 * annoyance, it is a hole in something we sell as proof. So the rule here is an
 * invariant and not a nicety: **no kernel failure exists without a routable code**,
 * and anything thrown that is not already one gets wrapped before it is chained,
 * never after. Wrapping after the fact loses the stack that explains it.
 *
 * This file deliberately depends on nothing. It is the leaf every other kernel
 * module imports, which is what makes carrying a code everywhere cost one import
 * rather than a new edge in the dependency graph.
 */

/**
 * The closed set of things the kernel can refuse to do.
 *
 * Closed on purpose. A free-form string would let a call site invent a code that
 * no consumer knows how to route, which is the same failure as having no code at
 * all, only harder to notice.
 */
export type KernelErrorCode =
	/** A key was asked for and nothing provides it. Distinct from "pending". */
	| "service_absent"
	/** Two providers claimed the same key. Silent last-wins hides a real conflict. */
	| "service_duplicate"
	/** A component asked for a permission that no source grants. */
	| "permission_absent"
	/** A permission source exists and answered no. Distinct from absent, and it matters. */
	| "permission_denied"
	/** An effect was registered while its own scope was unwinding. */
	| "effect_after_unwind"
	/** A component's activation threw. Its partial effects have been unwound. */
	| "activation_failed"
	/** A component's disposer threw. The rest of the unwind still ran. */
	| "disposal_failed"
	/** A decision-point listener threw, so the decision did not happen. */
	| "listener_failed"
	/** A component declared a dependency on itself, directly or through others. */
	| "dependency_cycle"
	/** Something threw that was not an Error and not one of ours. */
	| "unknown";

/**
 * A kernel failure.
 *
 * `cause` is chained rather than flattened into the message, because a stack that
 * has been turned into a string is a stack nobody can walk.
 */
export class KernelError extends Error {
	readonly code: KernelErrorCode;

	/** What the failure is about: a service key, a component name, a permission. */
	readonly subject: string | undefined;

	constructor(
		code: KernelErrorCode,
		message: string,
		options?: { subject?: string; cause?: unknown },
	) {
		super(message, options?.cause === undefined ? undefined : { cause: options.cause });
		this.name = "KernelError";
		this.code = code;
		this.subject = options?.subject;
	}
}

/**
 * Turns anything at all into a KernelError, so no path can reach the record
 * without something to route on.
 *
 * A value that is already one passes through unchanged: re-wrapping would bury the
 * original code under `unknown`, which is exactly the information the wrap exists
 * to preserve.
 *
 * Note the fallback code is `unknown` and not something more specific. A wrapper
 * that guessed would produce a routable code that routes to the wrong place, and a
 * confidently wrong code is worse than an honest one.
 */
export function asKernelError(thrown: unknown, subject?: string): KernelError {
	if (thrown instanceof KernelError) return thrown;
	if (thrown instanceof Error) {
		return new KernelError("unknown", thrown.message, { subject, cause: thrown });
	}
	return new KernelError("unknown", String(thrown), { subject, cause: thrown });
}

/**
 * The shape a failure takes when it enters the record.
 *
 * Three fields for three audiences: `code` routes, `message` reads, `subject`
 * groups. `cause` is deliberately absent, because a chained cause is an object
 * graph and the record holds facts, not heaps. Whoever needs the stack has the
 * live error; whoever reads the chain six months later needs the three fields.
 */
export interface RecordableFailure {
	readonly code: KernelErrorCode;
	readonly message: string;
	readonly subject?: string;
}

/** Flattens a failure for the record, wrapping first so a bad throw still carries a code. */
export function recordable(thrown: unknown, subject?: string): RecordableFailure {
	const error = asKernelError(thrown, subject);
	return error.subject === undefined
		? { code: error.code, message: error.message }
		: { code: error.code, message: error.message, subject: error.subject };
}
