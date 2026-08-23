/**
 * A world is a group of seams, and it is swapped as a group or not at all.
 *
 * The single most useful sentence from the sandbox study, and it took a while to see
 * why it mattered: **remote execution is not a backend of the confinement seam**.
 * Confining presupposes a shared filesystem. A hosted world does not confine differently,
 * it puts the files and the processes somewhere else, which is a different question
 * wearing the same coat.
 *
 * So what gets replaced is a **coherent group**: files and processes together, never one
 * of them. A deployment with a remote file provider and a local process provider is not
 * a hybrid, it is two worlds, and the persona lives in whichever one the last call
 * happened to reach.
 *
 * ## The property that makes the swap safe
 *
 * Every world returns the same shapes for the same outcomes, **including the failures**.
 * The failure half is the one that gets skipped and the one that bites: a hosted runner
 * whose timeout produced a different shape than the local one would make the loop behave
 * differently depending on where it ran, and it would show up as a run that works
 * locally.
 *
 * ## What a world is not allowed to be
 *
 * A place where a decision gets made. The gate decided before anything reached here, so
 * a world runs what it is given. Putting a check inside would move enforcement into the
 * component furthest from the operator's consent, and a hosted runner would be enforcing
 * on itself.
 */

import type { BackendReport, ConfinementPolicy } from "./policy.js";

/** Where a group of seams lives. */
export type WorldKind = "machine" | "hosted";

/**
 * The seams a world owns, together.
 *
 * Named individually so it is visible that they travel as a set. A future seam that
 * belongs to a world belongs in this type, and one that does not belong here belongs to
 * neither world, which is the question to ask before adding anything.
 */
export interface WorldSeams {
	readonly files: string;
	readonly processes: string;
}

export interface World {
	readonly kind: WorldKind;
	/** How a record names it, so a person knows which machine to go and look at. */
	readonly label: string;
	readonly seams: WorldSeams;
	/** What it can confine with, when it can confine at all. */
	readonly backend?: BackendReport;
}

/** Why a world cannot be used for a run. Each case names itself. */
export type WorldRefusal =
	| { readonly why: "split_world"; readonly detail: string }
	| { readonly why: "no_confinement"; readonly mode: string }
	| { readonly why: "no_transport"; readonly from: string; readonly to: string };

export type WorldChoice =
	| { readonly ok: true; readonly world: World }
	| { readonly ok: false; readonly refusal: WorldRefusal };

/**
 * Checks that a world's seams actually come from one place.
 *
 * Cheap, and it catches the configuration mistake that produces the split world. It is
 * a string comparison rather than anything clever because the mistake is not subtle:
 * somebody points one seam at a remote provider and leaves the other alone.
 */
export function coherent(world: World): boolean {
	return world.seams.files === world.seams.processes;
}

/** Chooses a world for a run, and refuses rather than improvising. */
export function choose(world: World, policy: ConfinementPolicy): WorldChoice {
	if (!coherent(world)) {
		return {
			ok: false,
			refusal: {
				why: "split_world",
				detail: `files come from ${world.seams.files} and processes from ${world.seams.processes}, which is two worlds rather than one`,
			},
		};
	}
	if (policy.mode !== "full" && !world.backend) {
		return { ok: false, refusal: { why: "no_confinement", mode: policy.mode } };
	}
	return { ok: true, world };
}

/**
 * Whether one step's work can carry on in a different world than the last.
 *
 * Today: no, unless nothing moved. There is no transport between machines, and this
 * returns a refusal rather than pretending, because the alternative is a step that
 * silently starts somewhere its predecessor's files are not.
 *
 * The refusal is the honest shape of a missing feature. It is named, so a workspace can
 * show it, and it disappears on its own the day a transport exists, without anything
 * here changing except the one branch that currently has nothing to return.
 */
export function canHandOver(
	previous: World | undefined,
	next: World,
	transport: unknown | undefined,
): WorldChoice | { readonly ok: true } {
	if (!previous) return { ok: true };
	if (previous.label === next.label) return { ok: true };
	if (transport !== undefined) return { ok: true };
	return {
		ok: false,
		refusal: { why: "no_transport", from: previous.label, to: next.label },
	};
}

/**
 * How a refusal reads to a person.
 *
 * Written here rather than at each call site so the same situation reads the same way
 * everywhere, which is the difference between a message somebody recognises and three
 * messages about one problem.
 */
export function describeRefusal(refusal: WorldRefusal): string {
	switch (refusal.why) {
		case "split_world":
			return `This deployment is configured as two worlds at once: ${refusal.detail}.`;
		case "no_confinement":
			return (
				`Nothing here can confine a run to ${refusal.mode}, and running unconfined ` +
				"while believing otherwise is worse than not running."
			);
		case "no_transport":
			return (
				`This step would run on ${refusal.to} and the previous one ran on ${refusal.from}. ` +
				"Nothing moves work between machines yet, so the step is refused rather than " +
				"started somewhere its predecessor's files are not."
			);
	}
}
