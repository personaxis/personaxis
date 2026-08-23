/**
 * Talking to a model, and what a destination can be asked to do.
 *
 * The reference's transport contract is small and good, and the valuable half of it is
 * the **negative** list: a transport does not own client construction, streaming,
 * credential refresh, prompt caching, interrupts or retries. Without that sentence
 * every adapter grows into a small agent, and five of them grow into five different
 * small agents.
 *
 * Ours adds one item to that list. **A transport does not decide anything about the
 * persona.** An adapter that could trim tools, adjust effort or touch the compiled
 * identity would be a gate that runs after the gate, in a file nobody reviews as a gate.
 *
 * ## Capabilities are a table, not a cascade of predicates
 *
 * Their schema dialects live in functions, one per provider, and their destination is
 * recognised by running a dozen predicates over a hostname. Their own rule, written in
 * the file where they got it right, is the one they do not apply there: when a provider
 * rejects a level, **fix the declared set rather than adding another special case**.
 *
 * So a destination declares what it accepts and the caller reads the declaration. That
 * is also what lets a system with declared identity ask the question it wants to ask:
 * does this destination take signed reasoning, this cache window, this effort
 * vocabulary. Today that is answered by grepping a URL.
 *
 * ## Never escalate cost when a level is unknown
 *
 * Their worst silent bug, and the one piece of this subsystem worth copying without
 * changes. An unrecognised effort level fell back to a weak default, so **asking for
 * the maximum resolved weaker than asking for a middle level**: a ladder inversion, and
 * one that costs money in the direction nobody checks. The rule that came out of it is
 * keep the level when it is supported, otherwise step down to the nearest supported one
 * below, and never step up.
 */

/** How hard a model is being asked to think. Ordered, weakest first. */
export const EFFORT_LADDER = ["minimal", "low", "medium", "high", "max"] as const;

export type Effort = (typeof EFFORT_LADDER)[number];

/** What a destination says it can do. Data, so it can be compared and reported. */
export interface DestinationCapabilities {
	readonly id: string;
	/** The effort levels it accepts. An empty set means it takes none. */
	readonly effort: readonly Effort[];
	/** Whether it accepts reasoning material signed by somebody else. */
	readonly foreignReasoning: boolean;
	/** How long it will hold a cached prefix, in seconds. Zero means it will not. */
	readonly cacheSeconds: number;
	/** Schema features it rejects, named rather than discovered by a 400. */
	readonly rejects: readonly string[];
}

/**
 * Resolves an asked-for effort against what a destination accepts.
 *
 * Keeps it if it is supported. Otherwise steps **down** to the nearest supported level,
 * and if nothing below is supported, takes the weakest that is. Never steps up, because
 * a request that silently costs more than it asked for is a bill nobody can explain.
 *
 * Returns what was resolved and whether it moved, so a caller can put the move in the
 * record. A downgrade that nobody can see is a downgrade somebody argues about later.
 */
export function resolveEffort(
	asked: Effort,
	destination: DestinationCapabilities,
): { readonly effort: Effort | undefined; readonly downgradedFrom?: Effort } {
	if (destination.effort.length === 0) return { effort: undefined };
	if (destination.effort.includes(asked)) return { effort: asked };

	const wanted = EFFORT_LADDER.indexOf(asked);
	for (let index = wanted - 1; index >= 0; index -= 1) {
		const candidate = EFFORT_LADDER[index]!;
		if (destination.effort.includes(candidate)) {
			return { effort: candidate, downgradedFrom: asked };
		}
	}
	// Nothing below is supported, so take the weakest that is. Still a downgrade in
	// spirit even when the ladder ran out, and it is reported as one.
	const weakest = EFFORT_LADDER.find((level) => destination.effort.includes(level));
	return weakest === undefined
		? { effort: undefined }
		: { effort: weakest, downgradedFrom: asked };
}

/**
 * Whether reasoning material produced elsewhere may be replayed here.
 *
 * The record keeps the text and a reference with the issuer stamped, so this is
 * answerable without holding the artifact, which is the point of stamping it. Replaying
 * a sealed blob against a destination that did not issue it fails deterministically, so
 * a wrong answer here is not a degraded response but a rejected request.
 */
export function mayReplay(issuer: string, destination: DestinationCapabilities): boolean {
	if (issuer === destination.id) return true;
	return destination.foreignReasoning;
}

/**
 * Everything a destination is asked to do in one call, after resolution.
 *
 * Built by whoever composes the request, never by the transport. The transport turns
 * this into the wire shape and turns the response back, and that is its whole job.
 */
export interface ModelRequest {
	readonly destination: string;
	readonly effort?: Effort;
	readonly messages: readonly { readonly role: string; readonly text: string }[];
	readonly tools: readonly string[];
}

/**
 * What a transport must do, and the list of what it must not.
 *
 * The negative list is in the type as a comment rather than as a mechanism because no
 * type can stop an adapter opening a socket. What it can do is make the intent
 * unambiguous, so a review that finds retry logic in here has something to point at.
 */
export interface Transport {
	readonly name: string;
	/**
	 * Sends and returns.
	 *
	 * Does NOT own: client construction, streaming, credential refresh, prompt caching,
	 * interrupts, retries, or any decision about the persona.
	 */
	send(request: ModelRequest, signal?: AbortSignal): Promise<{ readonly text: string }>;
}

/**
 * Sanitises per destination, on a copy.
 *
 * Their bug, and it generalises to anything done per destination: a sanitiser that
 * mutated in place held a direct reference to the agent's shared tool registry, so the
 * first request to one strict provider left that registry **permanently trimmed for
 * every later call to every other provider**. The fix there was a deep copy; the rule
 * here is that anything destination-specific happens on a copy, and it is a rule rather
 * than a fix so nobody has to rediscover it per adapter.
 */
export function forDestination(
	request: ModelRequest,
	destination: DestinationCapabilities,
): ModelRequest {
	const resolved = request.effort ? resolveEffort(request.effort, destination) : { effort: undefined };
	return {
		destination: destination.id,
		...(resolved.effort ? { effort: resolved.effort } : {}),
		messages: request.messages.map((message) => ({ ...message })),
		tools: [...request.tools],
	};
}
