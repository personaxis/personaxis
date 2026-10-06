/**
 * The second axis, on the machine where the calls actually happen.
 *
 * `gate/identity.ts` has existed since the third phase and had zero consumers. It
 * weighs a call against the persona's declared envelope, which is the question
 * nobody else can ask, and it was answering it only in tests. This is the file that
 * puts it on the road.
 *
 * ## Why mounting the guard was not enough on its own
 *
 * The guard reads `call.effects`, and **nothing in this repository produced one**.
 * Measured on 2026-09-04: `CoordinateEffect` had a definition, a test, and no
 * writer anywhere in `core`, `cli` or `protocol`. So a guard wired into the daemon
 * with an empty effect list would have refused nothing, forever, while every screen
 * said the second axis was in force. That is worse than the gap it closes.
 *
 * So this file does two things, and the second is the real one: it derives what a
 * call would do to the persona's coordinates, from what the call itself declares.
 *
 * ## Where an effect comes from, and why it is not an estimate
 *
 * `identity.ts` says it will not estimate its own inputs, and it should not: a gate
 * that guessed what a call would do would be marking its own homework. So the only
 * effects produced here are ones the call states outright.
 *
 * The case that matters is an agent writing `state.json`. Current coordinates live
 * in that file, the engine moves them through `governMutations`, which clamps to the
 * envelope and bounds the step, and **a file write goes around all of it**. An agent
 * that decides to raise its own autonomy does not call `state mutate`, which is
 * governed; it writes the file, which until now nothing stopped. The values it wants
 * are right there in the payload, so weighing them is reading, not guessing.
 *
 * ## What an unreadable write means
 *
 * A call that names the state file and whose new content cannot be read is refused,
 * not allowed. Two ways to get there, and both are ordinary: a partial edit that
 * replaces a fragment rather than the document, and the ACP path, whose arguments
 * are truncated at 4,000 characters, so a large state file arrives cut in half.
 *
 * "I cannot see what this would do to the persona" is not a reason to let it
 * through. It is the one case where the axis has to answer with the fact that it
 * cannot weigh the call.
 *
 * ## What this deliberately does not cover, measured rather than assumed
 *
 * **Rewriting the envelope itself.** The spec file declares the ranges this axis
 * measures against, and it is read fresh on every call, so an agent that widened a
 * range in `personaxis.md` and then wrote the value would be weighed against the
 * range it just wrote. Reading it fresh is still right: the operator edits that file
 * on purpose, and an axis measuring against a range from process start would refuse
 * legitimate work all afternoon. Closing it properly is a decision about what
 * happens when an agent edits the persona's own declaration, which is a product
 * question and not this file's to answer.
 *
 * **A shell redirect.** This axis reads named arguments, and a command's text is not
 * one, so `echo {...} > .personaxis/state.json` is not weighed here. It used to earn
 * no writing class at all; since E26 it earns `external_write`, and since E63 the
 * compiled policy refuses any write whose command names `.personaxis`, under every
 * posture, precisely because nothing reads what such a write would put there.
 *
 * **Values a write removes.** The effects are the coordinates the new document
 * names. A document that drops one changes the persona too, and `examine` has
 * nothing to say about an absence.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import {
	extractEnvelopes,
	gate,
	readMode,
	type ActionClass,
	type ImprovementMode,
} from "@personaxis/core";
import matter from "gray-matter";

import type { EnforceRequest } from "./enforcement-endpoint.js";
import { withinScope } from "./scope-guard.js";

/**
 * The classes that mean the call would put something on disk.
 *
 * Named here rather than inferred from the tool, for the same reason the whole
 * translation table exists: tool names change with every host, consequences do not.
 * `spend` is not in the list even though the policy compiler counts it as writing,
 * because moving money does not move a coordinate and a call that did both would
 * already be here on the other class.
 */
const WRITING: readonly ActionClass[] = ["external_write", "file_delete"];

/** Where a consented directory keeps the persona this machine enforces. */
export interface PersonaFiles {
	/** The compiled document, whose frontmatter declares the envelopes. */
	readonly spec: string;
	/** Its sibling, holding where each coordinate currently sits. */
	readonly state: string;
}

export function personaFilesIn(root: string): PersonaFiles {
	return {
		spec: join(root, ".personaxis", "personaxis.md"),
		state: join(root, ".personaxis", "state.json"),
	};
}

/**
 * Turns the improvement mode into the posture a band crossing gets.
 *
 * Two vocabularies for one idea, and translating them here keeps them from becoming
 * two ideas. `locked` means only a human-directed mutation passes, and a call from
 * an agent is not one, so a crossing under it is refused. `suggesting` means the
 * persona may propose and a person disposes, which is exactly an ask. `autonomous`
 * means the persona may, and the record says it did.
 */
export function postureOf(mode: ImprovementMode): gate.CrossingPosture {
	if (mode === "locked") return "locked";
	if (mode === "autonomous") return "autonomous";
	return "review";
}

/**
 * The persona's declared envelope, its current position, and who governs a crossing.
 *
 * Read from disk on every call rather than cached, because both halves move: the
 * coordinates change every turn the persona takes, and an operator edits the spec
 * whenever they mean to. A cached copy would refuse work that a file on disk already
 * permits, which is the failure that teaches people to switch enforcement off.
 */
export function identityPolicyFor(root: string): gate.IdentityPolicy | null {
	const files = personaFilesIn(root);
	if (!existsSync(files.spec)) return null;

	let frontmatter: Record<string, unknown>;
	try {
		frontmatter = (matter(readFileSync(files.spec, "utf-8")).data ?? {}) as Record<string, unknown>;
	} catch {
		// Unreadable spec. Returning null hands the call to the rest of the cascade,
		// which already refuses a directory whose persona this machine cannot compile:
		// inventing an empty envelope here would be an axis that permits everything
		// while looking like it was measuring something.
		return null;
	}

	const lookup = extractEnvelopes(frontmatter as never);
	if (Object.keys(lookup.envelopes).length === 0) return null;

	const postures: Record<string, gate.CrossingPosture> = {};
	// A field a hard-enforced virtue protects is never the persona's to move, whatever
	// the improvement mode says. Exact field names, which `postureFor` matches as the
	// longest prefix, so these win over the fallback.
	for (const field of lookup.protectedFields ?? []) postures[field] = "locked";

	return {
		envelopes: lookup.envelopes,
		current: currentValues(files.state),
		postures,
		fallback: postureOf(readMode(frontmatter, files.spec)),
	};
}

/** Where the coordinates sit now, or nothing when the file is missing or torn. */
function currentValues(statePath: string): Record<string, number> {
	if (!existsSync(statePath)) return {};
	try {
		const parsed = JSON.parse(readFileSync(statePath, "utf-8")) as { values?: unknown };
		return numbersIn(parsed.values);
	} catch {
		// `examine` falls back to the envelope's mean for a coordinate it has no current
		// value for, so an unreadable state file costs the axis its knowledge of
		// crossings and keeps its knowledge of the range. Leaving the range unenforced
		// as well would be the wrong half to give up.
		return {};
	}
}

function numbersIn(value: unknown): Record<string, number> {
	if (!value || typeof value !== "object") return {};
	const out: Record<string, number> = {};
	for (const [field, raw] of Object.entries(value as Record<string, unknown>)) {
		if (typeof raw === "number" && Number.isFinite(raw)) out[field] = raw;
	}
	return out;
}

/**
 * Every string anywhere in the arguments.
 *
 * Walked rather than read by field name, because the field carrying a path is
 * `file_path` on one host, `path` on the next and `abs_path` on a third, and a
 * reader that knew the names would stop seeing the write the day somebody added a
 * fourth host. The same reasoning the class table is built on.
 */
function stringsIn(argsText: string): string[] {
	let payload: unknown;
	try {
		payload = JSON.parse(argsText);
	} catch {
		// Not JSON. The whole thing is one string, which is what a host that sends its
		// arguments as a command line produces.
		return [argsText];
	}

	const found: string[] = [];
	const walk = (node: unknown, depth: number): void => {
		if (depth > 8) return;
		if (typeof node === "string") {
			found.push(node);
			return;
		}
		if (!node || typeof node !== "object") return;
		for (const child of Object.values(node as Record<string, unknown>)) walk(child, depth + 1);
	};
	walk(payload, 0);
	return found;
}

/** True when any argument names the persona's state file, absolute or relative. */
export function namesState(argsText: string, cwd: string, statePath: string): boolean {
	for (const candidate of stringsIn(argsText)) {
		if (!candidate || candidate.length > 4_096) continue;
		if (!/state\.json/i.test(candidate)) continue;
		const absolute = isAbsolute(candidate) ? candidate : resolve(cwd, candidate);
		// Asked as a scope of exactly one file, so path comparison happens in the one
		// place that already knows which platforms fold case. A second normaliser here
		// would be right on Windows and wrong on macOS, which is how a check that looks
		// like it holds turns out never to have held.
		if (withinScope(absolute, [statePath])) return true;
	}
	return false;
}

/**
 * The coordinates a call declares it would write, when it declares them whole.
 *
 * Whole is the operative word: a document that parses and carries a `values` object
 * is a statement about where every named coordinate ends up. Anything less is not
 * read optimistically, it is handed back as unreadable, and the guard below refuses
 * on it.
 */
export function declaredValues(argsText: string): Record<string, number> | undefined {
	for (const candidate of stringsIn(argsText)) {
		if (!candidate.includes("values")) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(candidate);
		} catch {
			continue;
		}
		if (!parsed || typeof parsed !== "object") continue;
		const values = (parsed as { values?: unknown }).values;
		if (!values || typeof values !== "object") continue;
		return numbersIn(values);
	}
	return undefined;
}

/**
 * Refuses a write to the state file that this machine cannot read.
 *
 * The companion to the identity guard rather than part of it, because they answer
 * different questions and folding them together would hide that. The identity guard
 * weighs an effect. This one exists for the calls that HAVE an effect and will not
 * say what it is, which the identity guard cannot see at all: an empty effect list
 * looks the same to it whether the call touches nothing or refuses to explain
 * itself.
 */
export function opaqueStateWriteGuard(statePath: string): gate.Guard {
	return {
		name: "identity-opaque",
		check: () =>
			gate.deny(
				"state_write_unreadable",
				`this call would write ${statePath}, where the persona's coordinates live, and this machine cannot read what it would put there, so it cannot tell whether the persona would still be within its declared envelope`,
			),
	};
}

/**
 * The consented directory a call was made in, or nothing when it was made outside
 * all of them.
 *
 * Longest match, so a persona in a subdirectory governs over the one at the root,
 * which is the rule the daemon already uses to decide whose policy applies.
 * Containment is asked of `withinScope` rather than reimplemented: a scope check that
 * compares prefixes admits `/workspace-of-someone-else` for `/work`, and the comment
 * on that function says that mistake has been made before.
 */
export function rootFor(cwd: string, scope: readonly string[]): string | null {
	let best: string | null = null;
	for (const dir of scope) {
		if (!withinScope(cwd, [dir])) continue;
		if (!best || dir.length > best.length) best = dir;
	}
	return best;
}

/** What the second axis contributes to one call. */
export interface IdentityAxis {
	/** What the call declares it would do to declared coordinates. Usually empty. */
	readonly effects: readonly gate.CoordinateEffect[];
	/** The guards that weigh it, judged alongside the built-in ones. */
	readonly guards: readonly gate.Guard[];
}

/**
 * The second axis for one call, or nothing when this machine has no envelope to
 * measure against.
 *
 * Nothing is the ordinary answer for a directory with no local persona, and it is
 * not an allow: the rest of the cascade already refuses there under its own name.
 * This says only that the identity question has no referent here, which is the
 * distinction `identity.ts` opens with.
 */
export function identityAxisFor(
	root: string,
	request: EnforceRequest,
	classes: readonly ActionClass[],
): IdentityAxis | null {
	const policy = identityPolicyFor(root);
	if (!policy) return null;

	const guards: gate.Guard[] = [{ name: "identity", check: gate.identityGuard(policy) }];

	const writes = classes.some((cls) => WRITING.includes(cls));
	const files = personaFilesIn(root);
	if (!writes || !namesState(request.args_text, request.cwd, files.state)) {
		// Not a write to the state file. The axis still runs, on whatever effects
		// somebody else may have attached, which today is nothing and one day will be
		// an appraiser.
		return { effects: [], guards };
	}

	const declared = declaredValues(request.args_text);
	if (!declared) return { effects: [], guards: [...guards, opaqueStateWriteGuard(files.state)] };

	return {
		effects: Object.entries(declared).map(([field, to]) => ({ field, to })),
		guards,
	};
}

/**
 * The dependency the daemon mounts, over the directories the operator consented to.
 *
 * A factory rather than a value, because the scope is fixed when `connect` starts and
 * the call is not: every request arrives with its own directory, and which envelope
 * applies is a question about that directory.
 */
export function identityOver(
	scope: readonly string[],
): (request: EnforceRequest, classes: readonly ActionClass[]) => IdentityAxis | null {
	return (request, classes) => {
		const root = rootFor(request.cwd, scope);
		return root ? identityAxisFor(root, request, classes) : null;
	};
}
