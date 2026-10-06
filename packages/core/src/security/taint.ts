/**
 * A value that came from outside, and cannot be read without saying so.
 *
 * The injection defence that works is not a better scanner. Every scanner has a
 * bypass, and a model-level instruction not to obey text it reads has none at all:
 * there is no mechanism behind it. What works is a boundary the code cannot cross by
 * forgetting.
 *
 * Before this, the boundary was a habit. `ToolInterceptor.run` returned an
 * `outputVerdict` and the loop wrote `contextTaint = maxTaint(contextTaint,
 * r.outputVerdict)` beside it. Correct, and correct in the way that lasts until
 * somebody adds a second place that runs a tool, copies the four lines that matter and
 * not the fifth. Nothing fails. The taint simply stops accumulating, the consent
 * matrix stops tightening, and a destructive action during a malicious-tainted turn is
 * allowed by a check that ran and had nothing to check.
 *
 * ## How the type carries it
 *
 * The value lives behind a symbol this module declares and does not export. Nothing
 * outside can construct one, and nothing outside can read one: `accept` is the only
 * door, and it returns the value TOGETHER WITH the taint that reading it produced. A
 * caller that wants the string has the taint in the same expression, which is the
 * whole trick. Forgetting is not carelessness any more, it is a type error.
 *
 * ## What this is not
 *
 * It is not a sanitiser. It never rewrites what it carries: a value edited on the way
 * through makes the record lie about what the tool returned, which is the same defect
 * as a guard rewriting a call's arguments, and this repository has now met it three
 * times in three different subsystems.
 *
 * It is also not the gate. A tainted value reaching a decision does not stop the
 * decision; it raises what the decision has to survive. The consent matrix is what
 * turns "the context is malicious" into "this destructive call does not run".
 */

import type { ContextTaint } from "./consent.js";

/**
 * The key the value hides behind. Real at runtime, and not exported.
 *
 * A `declare const ... : unique symbol` would be a type-level phantom and nothing else,
 * which is what this was written as first: the types were perfect and every call threw
 * `TAINTED is not defined`, because the property it indexed had no key to sit under.
 *
 * A module-scoped `Symbol()` is inferred as a `unique symbol` and exists, so the brand
 * is enforced by the compiler AND the box actually holds something. Not exporting it is
 * what makes the type opaque: nothing outside this file can construct one or read one.
 */
const TAINTED = Symbol("personaxis.tainted");

/**
 * Something read from outside the trust boundary.
 *
 * The type parameter is what it carries. The brand is a phantom and never exists at
 * runtime; it is here so a plain string cannot be passed where a checked one belongs.
 */
export interface Tainted<T> {
	readonly [TAINTED]: {
		readonly value: T;
		readonly taint: ContextTaint;
		/** Where it came from, so a refusal can name it rather than say "something". */
		readonly origin: string;
	};
}

/**
 * Marks a value as having come from outside.
 *
 * Called at the boundary and nowhere else: a tool's output, a fetched page, a file the
 * persona did not write. Everything downstream inherits the obligation from the type.
 */
export function fromOutside<T>(value: T, taint: ContextTaint, origin: string): Tainted<T> {
	return { [TAINTED]: { value, taint, origin } } as Tainted<T>;
}

/**
 * A tainted value, read, with the taint that reading it produced.
 *
 * Named rather than written inline on `accept`, and not for tidiness: the brand is a
 * symbol this module does not export, so a caller outside cannot spell the shape of an
 * anonymous return and TypeScript refuses to infer it. A caller that could not name
 * the result would have to widen it to `any`, which is precisely the hole this file
 * exists to close.
 */
export interface Accepted<T> {
	readonly value: T;
	/** The taint carried in, combined with the taint carried by the value. */
	readonly taint: ContextTaint;
	readonly origin: string;
}

/**
 * The only way to read one, and it hands back the taint at the same time.
 *
 * `into` is the taint accumulated so far, and the result carries the two combined. A
 * caller cannot take the value and leave the taint behind, because they arrive in one
 * object from one call.
 */
export function accept<T>(value: Tainted<T>, into: ContextTaint): Accepted<T> {
	const held = value[TAINTED];
	return {
		value: held.value,
		taint: rank(held.taint) > rank(into) ? held.taint : into,
		origin: held.origin,
	};
}

/**
 * Deliberately, there is no way to read one PART of a tainted value.
 *
 * A  and an  were written and removed. They look harmless, and
 * they are the beginning of the hole: a caller that can ask the verdict without
 * taking the value will eventually ask the verdict, decide it is fine, and reach for
 * the value somewhere else.  hands over all three at once because the point
 * of this file is that they travel together.
 */

const ORDER: Record<ContextTaint, number> = { clean: 0, suspicious: 1, malicious: 2 };

function rank(taint: ContextTaint): number {
	return ORDER[taint];
}
