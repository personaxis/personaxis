/**
 * The kernel.
 *
 * A place to hang capabilities where none of them imports another, where the order
 * you mount things in does not matter, where taking one away undoes exactly what it
 * did, and where a component can be waiting on a permission the same way it waits
 * on a service.
 *
 * It runs beside what already works and does not touch it. The existing engine
 * migrates onto this in later phases, once the properties below are proven rather
 * than asserted.
 *
 * ## The rule that decided what is in here
 *
 * If a mechanism needs to know who the agent is, it is ours. Everything in this
 * folder passes that test: resolution has to know which subject a permission is
 * about, the record has to know who acted, and a suspension has to know whose
 * permission was withdrawn. Sandbox backends, model SDKs, terminals and
 * filesystems do not, and none of them is here.
 *
 * ## What to read first
 *
 * `context.ts` is the centre and its header explains the epoch, which is the idea
 * everything else hangs off. `bus.ts` explains why an event's dispatch mode belongs
 * to the event. `effects.ts` is short and explains reverse unwinding. `keys.ts` is
 * where permissions become a second axis of the same mechanism. `errors.ts` has no
 * dependencies and everything imports it.
 */

export {
	KernelError,
	asKernelError,
	recordable,
	type KernelErrorCode,
	type RecordableFailure,
} from "./errors.js";

export { EffectScope, once, type Disposer } from "./effects.js";

export {
	EventBus,
	event,
	type AwaitedListener,
	type DispatchMode,
	type DispatchReport,
	type EventDecl,
	type NotifyListener,
	type WaterfallListener,
} from "./bus.js";

export {
	GRANTED,
	PERMISSIONS,
	denied,
	permissionKey,
	serviceKey,
	type PermissionKey,
	type PermissionSource,
	type PermissionVerdict,
	type ServiceKey,
} from "./keys.js";

export {
	Kernel,
	LIFECYCLE,
	type Component,
	type ComponentContext,
	type ComponentState,
	type LifecycleEvent,
} from "./context.js";
