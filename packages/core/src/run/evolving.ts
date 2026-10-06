/**
 * One way to get an evolver for a persona.
 *
 * `runner-for.ts` did this for the turn loop and found that two callers had drifted
 * apart while looking identical. This is the same treatment for the OTHER loop, the
 * one that observes, appraises, evolves, recompiles and remembers, and it has four
 * callers rather than two: the `observe` command, the REPL, the protocol host and the
 * SDK. All four wrote the same three lines, and one of the three had drifted.
 *
 * ## What is derived here
 *
 * **The appraiser.** Every caller wrote `model ? new LlmAppraiser(...) : new
 * HeuristicAppraiser()`, which is not a choice any of them was making: it is the
 * persona's model, resolved, with the offline fallback that exists so a persona with no
 * model configured still runs. A caller that could pass a different appraiser would be
 * appraising this persona with something it never declared, and nobody reading the
 * spec could tell.
 *
 * ## What stays the caller's, and the one that had to stop being optional
 *
 * **Recompiling on drift is now a required decision.** It was optional, and two of the
 * four callers had simply not passed one: the REPL and `observe` recompile inline when
 * a band is crossed, while the protocol host and the SDK do not. That difference is
 * defensible and it is preserved exactly as it was. What is not defensible is arriving
 * at it by omission, because an omitted hook and a deliberate `null` read the same in
 * the code and only one of them is a decision. So the field is required and `null` is
 * spelled out at each of the two sites that mean it.
 *
 * It is worth being precise about what `null` costs, since it is not "nothing
 * happens": the loop still writes the pending marker, so the persona's compiled
 * document is known to be stale and `recompilePending` says so. The difference is who
 * pays for the rewrite and when. An interactive session pays immediately, because a
 * person is waiting and would otherwise talk to a document that no longer matches the
 * state. A library embedded in somebody's application does not, because spending their
 * model budget on a rewrite they did not ask for is not a decision a library gets to
 * make.
 *
 * Storage and governance stay optional because their defaults are real defaults: the
 * filesystem bundle and the persona's own `improvement_policy`, both of which are the
 * right answer when the caller says nothing.
 */

import type { Appraiser } from "../appraisal.js";
import type { LoopEvent } from "../events.js";
import type { GovernanceConfig } from "../governance.js";
import { HeuristicAppraiser } from "../heuristic-appraiser.js";
import { LlmAppraiser } from "../llm-appraiser.js";
import { LivingLoop, type TickInput, type TickReport } from "../loop.js";
import { resolveModel } from "../model-config.js";
import type { PersonaHandle } from "../persona.js";
import type { Storage } from "../ports/index.js";

/** What the persona says about itself, already read. */
export interface EvolvingFacts {
	readonly personaPath: string;
	readonly frontmatter: Record<string, unknown>;
	/**
	 * Where project-level configuration is read from.
	 *
	 * Optional because `resolveModel` already defaults it to the working directory,
	 * which is what every caller was relying on without saying so. Named here so a
	 * hosted caller, which has no meaningful working directory, has somewhere to put
	 * the answer instead of inheriting whichever folder the server happens to be in.
	 */
	readonly cwd?: string;
}

/** Rewriting the compiled document when the persona drifts, or a written decision not to. */
export type Recompile = ((handle: PersonaHandle) => Promise<void>) | null;

/** Everything the persona cannot answer. */
export interface EvolvingSession {
	/**
	 * Required on purpose. See the header: an omitted hook and a deliberate `null`
	 * read identically, and only one of them is a decision somebody made.
	 */
	readonly recompile: Recompile;
	readonly storage?: Storage;
	readonly governance?: Partial<GovernanceConfig>;
	/** Called for every event of the cycle, in order. */
	readonly onEvent?: (event: LoopEvent) => void;
}

/**
 * The appraiser this persona gets, as a value.
 *
 * Separate from the assembly so it can be checked without constructing a loop, which
 * touches the filesystem. A test that could only assert this by running a tick would
 * be asserting it through everything else that a tick does.
 */
export function appraiserFor(persona: EvolvingFacts): Appraiser {
	const model = resolveModel({
		personaPath: persona.personaPath,
		frontmatter: persona.frontmatter,
		...(persona.cwd === undefined ? {} : { cwd: persona.cwd }),
	});

	// The offline fallback is not a lesser mode, it is the reason a persona with no
	// model configured is still governed: the heuristic appraiser proposes, and every
	// clamp, gate and audit downstream is identical either way.
	return model ? new LlmAppraiser({ ...model, timeoutMs: 30_000 }) : new HeuristicAppraiser();
}

/**
 * What a consumer holds instead of a `LivingLoop`.
 *
 * Four members, which is all four callers ever used between them. Narrow on purpose:
 * a consumer holding the loop itself has to be edited again when the loop behind it
 * changes, and the whole point of the seam is that it does not.
 */
export interface Evolver {
	/** One governed cycle. */
	observe(input: TickInput): Promise<TickReport>;
	/**
	 * Listen for a while, then stop.
	 *
	 * Separate from `onEvent` because they answer different questions and only one of
	 * them can be answered at construction. `onEvent` is for a consumer that wants
	 * every event of every cycle, and taking it up front is what makes it impossible
	 * to attach after the first cycle and see an empty stream with no error. This is
	 * for a consumer that wants ONE cycle's events, which is what an interactive turn
	 * is: it draws what happened during that turn and then stops caring.
	 */
	on(listener: (event: LoopEvent) => void): () => void;
	/** Who this is, for anything that needs to name the persona. */
	readonly persona: PersonaHandle;
	/** The session this evolver's cycles belong to. */
	readonly sessionId: string;
}

export function evolverFor(persona: EvolvingFacts, session: EvolvingSession): Evolver {
	const loop = new LivingLoop(persona.personaPath, {
		appraiser: appraiserFor(persona),
		...(session.recompile === null ? {} : { recompile: session.recompile }),
		...(session.storage === undefined ? {} : { storage: session.storage }),
		...(session.governance === undefined ? {} : { governance: session.governance }),
	});

	// Subscribed here rather than handed back, so a caller cannot attach after the
	// first cycle has already run and then wonder why it saw no events.
	if (session.onEvent) loop.bus.on(session.onEvent);

	return {
		observe: (input) => loop.tick(input),
		on: (listener) => loop.bus.on(listener),
		persona: loop.persona,
		sessionId: loop.sessionId,
	};
}
