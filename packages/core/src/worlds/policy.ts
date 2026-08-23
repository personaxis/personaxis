/**
 * The confinement a run happens under, kept apart from whatever applies it.
 *
 * Two things live here that the study said should never be one thing: **the mode**,
 * which is what a persona is allowed to touch, and **the backend**, which is the piece
 * of the operating system that makes that true. Separating them is not tidiness; both
 * of the reference's families, the shell and the filesystem, apply the same mode, and
 * when each carried its own the two drifted into **two different worlds**, with the
 * shell confined to one directory and file access to another.
 *
 * ## The policy travels with the call
 *
 * Not fixed on the provider. Their reason is written down and it is the right one: a
 * per-process mode cannot serve two consumers at once. And it makes a retry with wider
 * permission simply another call with another policy, with no state to reconcile.
 *
 * ## The durable mode is an entry, and the effective mode is a fold
 *
 * There is no configuration store. A session's mode survives a restart by replay, and
 * two sessions never see each other's. It is the same shape as the record being the
 * state, applied to policy, which is why it needs no second mechanism.
 *
 * ## What confinement is not
 *
 * It is not remote execution. Confining presupposes a shared filesystem, so a hosted
 * world is not another backend of this seam: it replaces a **coherent group** of seams,
 * files and processes together, and swapping one without the other produces a world that
 * is half local and half remote, which is two worlds.
 *
 * And it is not a security boundary. The gate decided before anything got here.
 *
 * ## The one thing no backend gives us
 *
 * Egress. Our own criterion says controlling where data goes is disqualifying, and the
 * reference restricts network in **no mode at all** and says so. They also rejected a
 * half-measure with an argument we agree with: limiting browsing while the shell makes
 * requests freely is a false boundary.
 *
 * So egress is ours to build on top of whichever backend we pick, and it is not a
 * criterion for picking one, because no candidate has it.
 */

/** What a persona may touch where it runs. Ordered, most permissive first. */
export type ConfinementMode = "full" | "workspace-write" | "read-only";

const RANK: Record<ConfinementMode, number> = { "read-only": 0, "workspace-write": 1, full: 2 };

/** The narrower of two modes. Widening is never the result of combining. */
export function narrower(left: ConfinementMode, right: ConfinementMode): ConfinementMode {
	return RANK[left] <= RANK[right] ? left : right;
}

/** How completely a backend delivers a mode. Reported, never promoted. */
export type Completeness = "complete" | "partial";

export interface ConfinementPolicy {
	readonly mode: ConfinementMode;
	/**
	 * The one definition of what is writable, shared by every family that applies it.
	 *
	 * One list rather than one per family, because the moment the shell and the
	 * filesystem each keep their own, the two drift and the persona lives in two worlds
	 * at once.
	 */
	readonly writableRoots: readonly string[];
	/**
	 * Where the persona may reach on the network. Absent is denial, not silence.
	 *
	 * The default is nothing, because it is the only default that makes a new connector
	 * safe before anyone has thought about which hosts it needs.
	 */
	readonly egressAllowlist: readonly string[];
}

/** A durable change to the mode, folded last-wins. */
export interface ModeEvent {
	readonly mode: ConfinementMode;
	/** Who changed it, so a fold can be read as well as computed. */
	readonly by: string;
}

/**
 * The mode in force, from the events that set it.
 *
 * Last-wins over a list, with a declared default when the list is empty. Derived rather
 * than stored, so it cannot go stale, and so a restart recovers it by replay instead of
 * by reading a second place that could disagree.
 */
export function effectiveMode(
	events: readonly ModeEvent[],
	deploymentDefault: ConfinementMode,
): ConfinementMode {
	const last = events.at(-1);
	return last ? last.mode : deploymentDefault;
}

/** What a backend says it can actually deliver. */
export interface BackendReport {
	readonly name: string;
	readonly completeness: Completeness;
	/** What it does not cover, named. A gap nobody named is a gap nobody plans around. */
	readonly gaps: readonly string[];
}

/**
 * Whether a policy may be applied by a backend, and what is lost if it is.
 *
 * Partial is reported as partial and never promoted, which the reference does for its
 * Windows backend in its own documentation rather than leaving it implicit. Saying "this
 * restricts writes and not reads or network" out loud is worth more than the restriction
 * it is admitting to.
 *
 * And there is no unconfined passthrough. With no usable backend this refuses, because
 * running unconfined while believing otherwise is worse than not running.
 */
export type ApplyDecision =
	| { readonly ok: true; readonly completeness: Completeness; readonly gaps: readonly string[] }
	| { readonly ok: false; readonly reason: string };

export function applyWith(
	policy: ConfinementPolicy,
	backend: BackendReport | undefined,
): ApplyDecision {
	// The mode is asked about first, and the order matters. A mode that confines
	// nothing needs no backend, so refusing it for want of one would refuse a persona
	// that was deliberately granted full access, with a message about confinement it
	// never asked for.
	if (policy.mode === "full") {
		return { ok: true, completeness: "complete", gaps: [] };
	}
	if (!backend) {
		return {
			ok: false,
			reason:
				"no confinement backend is available here, and running unconfined while " +
				"believing otherwise is worse than not running",
		};
	}
	return { ok: true, completeness: backend.completeness, gaps: backend.gaps };
}

/**
 * Whether a host may be reached, under this policy.
 *
 * Absence is denial. A prefix match on the host, never a substring anywhere in a URL,
 * because a substring check turns an allowlist into a suffix somebody can append to
 * their own domain.
 */
export function egressAllowed(host: string, policy: ConfinementPolicy): boolean {
	const target = host.toLowerCase();
	return policy.egressAllowlist.some((entry) => {
		const allowed = entry.toLowerCase();
		return target === allowed || target.endsWith(`.${allowed}`);
	});
}
