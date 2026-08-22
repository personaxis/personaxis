/**
 * How a component names what it needs without importing what provides it.
 *
 * A service key is a token carrying a type it never holds at runtime. That is the
 * whole trick: `ServiceKey<Clock>` compiles as if it were a `Clock`, and at runtime
 * it is a string in a box. A component that asks the context for that key gets a
 * typed value back without ever importing the module that registered it, which is
 * what keeps the dependency graph a star around the context instead of a web.
 *
 * ## Permissions are keys too, and that is our difference
 *
 * The reference kernel has one axis: a component is inactive until the services it
 * declared exist. Availability is a predicate with no subject, which is why their
 * capability layer keeps discovering that a probe answering "no" for a second
 * deletes a toolset from whatever agent happened to be starting.
 *
 * Ours carries a subject. A component may also declare the permissions it needs,
 * and a permission is answered *about somebody*: this persona, in this workspace,
 * on this machine. That collapses capability and permission into one mechanism
 * instead of two that have to be kept in agreement, and it is what lets a
 * withdrawn permission suspend exactly its dependents rather than restart an agent.
 *
 * The two key kinds are separate types on purpose. They are both boxes with a
 * string in them and they would interoperate happily, which is the problem: asking
 * the context to *provide* a permission, or to *grant* a service, are both mistakes
 * worth catching at compile time rather than at three in the morning.
 */

declare const SERVICE_TYPE: unique symbol;
declare const PERMISSION_SUBJECT: unique symbol;

/**
 * A typed name for something a component can be handed.
 *
 * `id` is what appears in a failure and in the record, so it should read like a
 * thing and not like a variable: `clock`, `persona.state`, `execution.port`.
 */
export interface ServiceKey<T> {
	readonly id: string;
	/** Phantom. Never present at runtime; exists so the type parameter is used. */
	readonly [SERVICE_TYPE]?: T;
}

/**
 * A typed name for something a component can be allowed.
 *
 * Distinct from a service because the answer is not a value but a verdict, and
 * because the verdict is always about a subject.
 */
export interface PermissionKey {
	readonly id: string;
	/** Phantom, and here it exists to keep permissions from passing as services. */
	readonly [PERMISSION_SUBJECT]?: true;
}

/**
 * Declares a service key.
 *
 * Call this once per service, at module scope, and export the result. Two calls
 * with the same id produce two keys that are equal by id, which is what makes a
 * duplicate registration detectable rather than a silent last-wins.
 */
export function serviceKey<T>(id: string): ServiceKey<T> {
	if (id.length === 0) {
		throw new Error("a service key needs an id, because a nameless key cannot be reported");
	}
	return { id };
}

/** Declares a permission key. Same rules, different axis. */
export function permissionKey(id: string): PermissionKey {
	if (id.length === 0) {
		throw new Error("a permission key needs an id, because a nameless key cannot be reported");
	}
	return { id };
}

/**
 * The verdict a permission source returns.
 *
 * Closed, with **no allow case that can be produced by accident**: the only way to
 * say yes is the literal `{ granted: true }`, and every other shape is a denial
 * that has to name itself. This is the same shape as the tool gate, and it is here
 * for the same reason. A source that fails to answer, times out, or throws is not
 * an implicit yes, and a type with an optional `granted?: boolean` would make it
 * one.
 *
 * `reason` on a denial is required rather than optional. Every path that is not a
 * clear allow denies **and says which no it is**, because "denied" without a reason
 * is the answer that sends somebody debugging in the wrong direction.
 */
export type PermissionVerdict =
	| { readonly granted: true }
	| { readonly granted: false; readonly reason: string };

/** The one way to say yes. Exported so no call site has to spell the literal. */
export const GRANTED: PermissionVerdict = { granted: true };

/** The many ways to say no, each of which has to name itself. */
export function denied(reason: string): PermissionVerdict {
	return { granted: false, reason };
}

/**
 * Something that can answer permission questions.
 *
 * A source is itself registered as a service, which is what makes permissions
 * dynamic without a second mechanism: replacing the source changes every answer,
 * and the components that depended on those answers reload through the ordinary
 * epoch path rather than through a bespoke invalidation.
 *
 * `answer` is synchronous on purpose. An asynchronous permission is a permission
 * that can hang, and a component suspended mid-question is indistinguishable from
 * one that was denied. Whatever needs the network resolves it before it becomes a
 * source, and a source that has not resolved yet simply is not registered, which
 * leaves its dependents pending rather than blocked.
 */
export interface PermissionSource {
	answer(permission: PermissionKey): PermissionVerdict;
}

/** The key the kernel looks for when a component declares a permission. */
export const PERMISSIONS: ServiceKey<PermissionSource> = serviceKey<PermissionSource>("kernel.permissions");
