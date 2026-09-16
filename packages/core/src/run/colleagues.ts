/**
 * E87: handing work to a colleague, and what it may do when it gets there.
 *
 * ## What a colleague is, and why it is not a new idea
 *
 * A sub-persona under the folder of whoever is asking. The work map already lists them by address, `@cmo` or
 * `@cmo/legal`, each with the purpose its own spec declares, under a heading that says they are who you can
 * hand work to. So the persona already sees them; what was missing is a way to actually do it.
 *
 * Nothing here chooses the colleague. `blackboard.ts` ranks volunteers by word overlap and no turn has ever
 * called it, and picking a worker by token similarity is precisely what this row rejected: the model names the
 * colleague it means, from the addresses in front of it.
 *
 * ## O22, decided by David on 2026-09-15: the lower ceiling of the two
 *
 * A colleague acts under the lower of its own ceiling and the asker's, which is least privilege and the only
 * answer that cannot be gamed from either side. It is measured that this has to cover BOTH axes the gate reads,
 * not just the sandbox: `evaluateCommand` returns `allow` for a risky operation when the approval mode is
 * `never` or `on-failure`, so a looser colleague would turn into silent permission what the asker would have
 * put in front of a person. And a delegated child never asks anybody (`C6b`), so the difference is not who is
 * asked; it is whether the operation runs at all.
 *
 * ## Where the ceiling lands, and why there and not somewhere else
 *
 * On the executable `Policy` the session lends the child. Read from the loop before writing this: the gate
 * judges each call against that policy, and then `capabilityGuard` evaluates the colleague's OWN compiled
 * document on top, which `agentOptionsFor` recompiles and no caller can override. So narrowing the lent policy
 * is the half a caller can decide, and the colleague's own limits keep applying above it. Neither half can
 * widen the other, which is what makes this least privilege rather than a negotiation.
 */

import { dirname, join } from "node:path";

import { stricterApproval, type ApprovalMode, type SandboxMode } from "../sandbox.js";
import { subPersonasOf, type MapItem } from "./work-map.js";

/** The two things a ceiling is made of, which are the two the gate reads. */
export interface Ceiling {
	readonly sandbox: SandboxMode;
	readonly approval: ApprovalMode;
}

/**
 * Sandbox postures from the loosest to the strictest, so "lower ceiling" is a lookup and not an opinion.
 *
 * Declared here because nothing declared it anywhere: the three values existed as a union and the code asked
 * about them one `if` at a time. The approval axis already had its order in `sandbox.ts` and is reused rather
 * than restated, because two scales for one question disagree the day somebody adds a value to one of them.
 */
const SANDBOX_STRICTNESS: readonly SandboxMode[] = ["danger-full-access", "workspace-write", "read-only"];

/**
 * The stricter of two postures, which on this axis is the lower ceiling.
 *
 * Internal, with the order above it: both are used by `lowerCeiling` and by nothing else, and an export
 * reached only from its own module is what the `designed-not-connected` sweep counts as unreachable. It was
 * exported at first and the ratchet caught it, which is the same correction `use_skill` needed on 2026-09-14.
 * What crosses the boundary is the ceiling, not the comparison that builds it.
 */
function lowerSandbox(a: SandboxMode, b: SandboxMode): SandboxMode {
	return SANDBOX_STRICTNESS.indexOf(a) >= SANDBOX_STRICTNESS.indexOf(b) ? a : b;
}

/**
 * The ceiling a colleague works under: the lower of its own and the asker's, on both axes.
 *
 * What the colleague did NOT declare is not a declaration, so it takes the asker's. That is deliberate and it
 * is the safe direction: absent cannot widen, because there is nothing to widen with, and reading absence as
 * "anything goes" is how a persona with a thin spec would end up freer than the one that asked it.
 */
export function lowerCeiling(asking: Ceiling, colleague: Partial<Ceiling>): Ceiling {
	return {
		sandbox: colleague.sandbox === undefined ? asking.sandbox : lowerSandbox(asking.sandbox, colleague.sandbox),
		approval: colleague.approval === undefined ? asking.approval : stricterApproval(asking.approval, colleague.approval),
	};
}

/** Whether an address is a name a persona could have written, rather than a path in disguise. */
function addressable(address: string): boolean {
	const segments = address.split("/");
	return (
		segments.length > 0 &&
		segments.every((segment) => segment.length > 0 && segment !== "." && segment !== ".." && !/[\\:*?"<>|]/.test(segment))
	);
}

/**
 * The colleagues this persona can hand work to, by address, each with the purpose its own spec declares.
 *
 * One owner: the same walk the work map renders, so what a persona is SHOWN and what it can actually reach
 * cannot drift apart. A second walk here would be the shape of bug this repository keeps finding, where the
 * index says one thing and the mechanism does another.
 */
export function colleaguesOf(personaPath: string): readonly MapItem[] {
	return subPersonasOf(dirname(personaPath));
}

/**
 * Where a colleague's spec lives, from the address the persona named.
 *
 * The inverse of the address the map shows: `cmo/legal` is `personas/cmo/personas/legal/personaxis.md` under
 * the asker's own folder. Undefined for an address that is not a name, so a traversal never becomes a path.
 */
export function colleaguePathFor(personaPath: string, address: string): string | undefined {
	const trimmed = address.trim().replace(/^@/, "");
	if (!trimmed || !addressable(trimmed)) return undefined;
	return join(dirname(personaPath), "personas", trimmed.split("/").join("/personas/"), "personaxis.md");
}
