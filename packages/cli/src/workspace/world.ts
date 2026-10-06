/**
 * This machine, declared as a world rather than assumed to be the only one.
 *
 * The daemon has always been the place work runs. What it was not was a **declared**
 * place, so nothing could ask it what it was, nothing could compare it to another, and
 * the question of whether a step could carry on somewhere else had no owner. It was
 * answered by the absence of any code to move work, which is an answer nobody wrote and
 * nobody can find.
 *
 * Declaring it costs one object and buys three things.
 *
 * A **split world is refused by name.** Both seams here come from the same place, which
 * is trivially true today and is exactly the assertion that stops being trivially true
 * the day a hosted file provider is added and somebody forgets the process one.
 *
 * **Confinement is reported honestly.** What this machine can actually confine with
 * depends on the operating system, and a partial backend says so instead of being
 * promoted to complete because it is the only one available.
 *
 * And **the missing transport refuses with both machine names**, so a workspace can show
 * why a step did not start rather than showing a job that quietly did not move.
 *
 * ## What this deliberately does not do
 *
 * Decide anything about a call. The gate decided before anything got here, and putting a
 * check in the thing that runs the work would move enforcement into the component
 * furthest from the operator's consent.
 */

import { hostname, platform } from "node:os";

import { worlds } from "@personaxis/core";

/**
 * What this operating system can actually confine with.
 *
 * Named rather than probed, and that is the point rather than a shortcut. Probing is
 * what the reference does and what it pays for: a probe that answers no once, under
 * load, removes a capability from whatever agent happens to be starting. What a
 * platform can confine with does not change between two calls in one turn, so it is
 * resolved once and declared.
 *
 * Windows is reported **partial** with its gaps named, because it restricts writes and
 * not reads or network. Saying that out loud is worth more than the restriction it is
 * admitting to, and the alternative is somebody assuming a confinement they do not have.
 */
export function confinementBackend(os: string = platform()): worlds.BackendReport | undefined {
	switch (os) {
		case "linux":
			return { name: "bwrap", completeness: "complete", gaps: [] };
		case "darwin":
			return { name: "sandbox-exec", completeness: "complete", gaps: [] };
		case "win32":
			return { name: "windows-acl", completeness: "partial", gaps: ["reads", "network"] };
		default:
			// Not "probably fine". A platform nobody wrote a backend for is a platform
			// where a confined mode is refused, which is the fail-closed reading and the
			// one that does not quietly run unconfined.
			return undefined;
	}
}

/**
 * The world this daemon is.
 *
 * The label is the machine's name because that is what somebody needs when a record says
 * where a step ran: an identifier tells them which row, a hostname tells them which
 * computer to walk to.
 */
export function thisMachine(options: { label?: string; os?: string } = {}): worlds.World {
	const backend = confinementBackend(options.os ?? platform());
	return {
		kind: "machine",
		label: options.label ?? hostname(),
		// Both from the same place, which is what "not a split world" means here. It is
		// trivially true today and is the assertion that stops being trivial the day a
		// hosted provider arrives.
		seams: { files: "local", processes: "local" },
		...(backend ? { backend } : {}),
	};
}

/**
 * Whether this machine will run a step, given the confinement it was asked for and where
 * the previous step ran.
 *
 * Two questions rather than one, because they fail for different reasons and a caller
 * needs to tell them apart: this machine cannot confine to what was asked, versus this
 * step belongs on a different machine and nothing moves work between them.
 */
export function willRun(
	policy: worlds.ConfinementPolicy,
	previous?: worlds.World,
	options: { label?: string; os?: string; transport?: unknown } = {},
): { readonly ok: true; readonly world: worlds.World } | { readonly ok: false; readonly reason: string } {
	const world = thisMachine(options);

	const chosen = worlds.choose(world, policy);
	if (!chosen.ok) return { ok: false, reason: worlds.describeRefusal(chosen.refusal) };

	const handover = worlds.canHandOver(previous, world, options.transport);
	if (!handover.ok) {
		return { ok: false, reason: worlds.describeRefusal(handover.refusal) };
	}

	return { ok: true, world };
}
