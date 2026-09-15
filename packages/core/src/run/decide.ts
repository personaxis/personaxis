/**
 * E83: deciding what a request needs before acting, for a model that needs the step.
 *
 * AgentFloor (2026) measured that small open models handle short, structured tool use well and fail at
 * planning over many steps, and that the same help works differently from one model to the next. The bench
 * shows it on the one case it has: asked which sources its advice is based on, Qwen3-4B answers from what
 * it half remembers, 0 of 3, while its own index lists the reference that holds them. It never decides to
 * look.
 *
 * So a destination whose scaffold is `small` gets one short call before the loop: no tools, the persona's
 * index already in the prefix, and a reply of one JSON object naming the route and why. The route comes back
 * as a note and takes nothing away. Every tool stays offered, because a guide the model can argue with costs
 * less than a cage it has to break out of. A model on `standard` never makes the call and pays nothing.
 *
 * What it does not do is guess. A reply that cannot be read leaves the turn without a route and says so,
 * rather than picking the likeliest one: a decision the runtime made up is exactly what the record must not
 * put in the persona's name.
 */

/**
 * What a request can need, in the order a persona should consider them. `service` joins with `E73`. Not
 * exported: nothing outside this file needs the list, and the rule on unreachable exports holds for it.
 */
const ROUTES = ["answer", "ask", "consult", "skills", "delegate", "work"] as const;

export type Route = (typeof ROUTES)[number];

export interface Decision {
	readonly route: Route;
	readonly why: string;
}

/** What each route means, said once, so the instruction and the note cannot drift apart. */
const MEANING: Record<Route, string> = {
	answer: "you can reply now from what you already know, with no tool",
	ask: "something you need is missing and only the person can give it, so ask for exactly that",
	consult: "the answer is in your own material, a reference or an example your index lists, so read it before replying",
	skills: "one of your skills fits this work, so load it before you start",
	delegate: "a colleague or one of your sub-personas is better placed, so hand it over",
	work: "it takes several steps that leave files, so plan them and then do them",
};

/** The one instruction the step sends. Only in the request, never kept in the conversation. */
export const DECIDE_INSTRUCTION = [
	"Before doing anything, decide what this request needs. Reply with ONLY one JSON object, no prose and no code fence:",
	'{"route": "<route>", "why": "<one line>"}',
	"The routes:",
	...ROUTES.map((route) => `- ${route}: ${MEANING[route]}.`),
].join("\n");

export type DecisionRead = { readonly ok: true; readonly decision: Decision } | { readonly ok: false; readonly error: string };

/**
 * The decision out of whatever the model said.
 *
 * Tolerant about packaging, because a fence or a sentence around the object is a formatting slip and not a
 * different answer. Strict about the route, because a route that is not one of these is not a decision the
 * loop can act on, and mapping it to the nearest one would be the runtime choosing.
 */
export function parseDecision(raw: string): DecisionRead {
	const text = raw.trim();
	if (!text) return { ok: false, error: "the reply was empty" };
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start === -1 || end <= start) return { ok: false, error: "the reply held no JSON object" };

	let parsed: unknown;
	try {
		parsed = JSON.parse(text.slice(start, end + 1));
	} catch {
		return { ok: false, error: "the JSON object could not be read" };
	}

	const record = (parsed ?? {}) as Record<string, unknown>;
	const route = typeof record.route === "string" ? record.route.trim().toLowerCase() : "";
	if (!(ROUTES as readonly string[]).includes(route)) {
		return { ok: false, error: `"${route || "no route"}" is not one of the routes` };
	}
	const why = typeof record.why === "string" ? record.why.replace(/\s+/g, " ").trim().slice(0, 240) : "";
	return { ok: true, decision: { route: route as Route, why } };
}

/** The note the model reads after deciding: what it chose, what that means, and that it may change course. */
export function describeDecision(decision: Decision): string {
	const why = decision.why ? ` (${decision.why})` : "";
	return (
		`You decided this request needs: ${decision.route}${why}. That means ${MEANING[decision.route]}. ` +
		"Every tool is still yours; if what you find changes what the request needs, say so and change course."
	);
}
