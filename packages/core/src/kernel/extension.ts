/**
 * Where a capability plugs in, declared by whoever consumes it.
 *
 * K3, and the problem it solves is the one that decides whether a core stays small. Today
 * `tools/mounted.ts` imports every built-in by name. Adding a capability means editing
 * that file, so the module that ASSEMBLES tools depends on every tool there is, and the
 * dependency points the wrong way: the thing that should be stable imports the things
 * that keep arriving.
 *
 * An extension point inverts it. The consumer declares a point, the contributor declares
 * a value for it, and **neither imports the other**: both import the declaration, which
 * is a name and a type and nothing else. That is the whole mechanism, and it is what
 * lets a capability arrive without the core growing a line.
 *
 * ## Why this is not a service key
 *
 * A service has exactly one provider and replacing it is an epoch change, because
 * everything that resolved against the old one has to be rebuilt. A point has MANY
 * contributors and one more arriving is not a change to what the others resolved
 * against. Same registry, different arity, and collapsing them would either make a
 * second tool a duplicate-provider error or make replacing a service silently additive.
 *
 * ## A contribution lives exactly as long as its component
 *
 * Contributing goes through `ComponentContext`, so the registration is tied to the
 * component's scope and comes down when the component suspends, reloads or unmounts.
 * That is the same property `mounted.ts` was getting by hand with a `Set` and a closure,
 * and the reason it is worth having once rather than at each call site: a withdrawn
 * permission has to remove the tool from the catalogue, not merely refuse it later.
 *
 * ## Order is contribution order, and that is load-bearing
 *
 * The tool catalogue becomes part of the prompt prefix. A registry that reshuffled
 * itself between turns would change the prefix for no reason a person could see, and
 * every token after it would be re-read by the provider. So this returns what was
 * contributed in the order it was contributed, which for components is mount order.
 */

/**
 * A named place things plug into.
 *
 * The type parameter is a phantom for the same reason `EventDecl`'s is: it has to be
 * used somewhere to be inferred, and a property is covariant where a method would not
 * be, so a concrete point can be passed to a helper that takes any point without a cast
 * at every call site.
 */
export interface ExtensionPoint<Contribution> {
	readonly id: string;
	readonly __contribution?: Contribution;
}

/** Declares a point. The id is what both sides agree on, and it is agreed here once. */
export function extensionPoint<Contribution>(id: string): ExtensionPoint<Contribution> {
	return { id };
}

/**
 * One thing contributed, and who contributed it.
 *
 * Not exported. The owner is kept because a removal has to find the right entry and
 * because a future catalogue screen will want to say where a tool came from; nothing
 * outside this file needs to name the shape yet, and an export whose only caller is its
 * own test is what the connectedness ratchet is for.
 */
interface Contributed<Contribution> {
	readonly by: string;
	readonly value: Contribution;
}

/**
 * The contributions to every point, held by whoever owns the kernel.
 *
 * A class rather than a Map so that removal is a disposer the contributor already holds,
 * which is what makes a contribution an effect like any other rather than something a
 * component has to remember to undo.
 */
export class Extensions {
	readonly #byPoint = new Map<string, Contributed<unknown>[]>();

	/**
	 * Adds one, and hands back the way to remove it.
	 *
	 * The disposer removes THAT entry by identity rather than by owner name, because one
	 * component may contribute several values to a point and removing all of them when
	 * one goes is a bug that only shows up in a plugin nobody wrote yet.
	 */
	add<Contribution>(
		point: ExtensionPoint<Contribution>,
		by: string,
		value: Contribution,
	): () => void {
		const held = this.#byPoint.get(point.id) ?? [];
		const entry: Contributed<unknown> = { by, value };
		held.push(entry);
		this.#byPoint.set(point.id, held);

		return () => {
			const list = this.#byPoint.get(point.id);
			if (!list) return;
			const at = list.indexOf(entry);
			if (at >= 0) list.splice(at, 1);
		};
	}

	/**
	 * What is contributed right now, in the order it arrived.
	 *
	 * An empty list for a point nobody has contributed to, which is a real answer and not
	 * a missing one: a host that offers a place to plug in and has nothing plugged in is
	 * working correctly.
	 */
	of<Contribution>(point: ExtensionPoint<Contribution>): readonly Contribution[] {
		return (this.#byPoint.get(point.id) ?? []).map((entry) => entry.value as Contribution);
	}
}
