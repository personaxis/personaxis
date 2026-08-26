/**
 * One way to get a runner for a persona.
 *
 * There were two, and they had drifted. The REPL and the SDK each built a
 * `PersonaAgent` by hand with a dozen options, and both re-derived the same things
 * from the same persona file: its budget, its verification block, its judge.
 * Re-derivation is not the cost. The cost is that a third caller derives them
 * slightly differently and nobody notices, which is what had already happened: the
 * SDK's agent got no awareness block, no goal, no session id and no meter, so a
 * persona answering through the SDK did not know what it knew in the REPL.
 *
 * ## What is derived here and what stays the caller's
 *
 * The split is not tidiness. It is where the answer comes from.
 *
 * **From the persona**: the model it declared, the judge that checks it, its agent
 * budget and its verification block. These are properties of who this persona is,
 * they are the same for every caller, and a caller that could pass them would be
 * changing the persona without editing it.
 *
 * **From the session**: who is asking, what was said before, what the goal is, who
 * answers an approval, where events go, which policy applies to this environment.
 * These differ per caller by nature, and inventing a default for "who is watching"
 * would be inventing an answer nobody gave.
 *
 * Assembly is trivial on purpose. It is not a place to add behaviour: anything it
 * decided would be a decision the callers could no longer make differently, and the
 * ones they make differently are the ones that must stay theirs.
 *
 * The session half is written as the COMPLEMENT of the derived half rather than as
 * its own list. A second list is a list that drifts: a new option added to the agent
 * would silently belong to neither, and this way it lands on the caller's side,
 * which is the right default. A knob is the caller's until somebody decides it is
 * the persona's.
 *
 * ## Why it returns a runner and not an agent
 *
 * Because the agent is the thing being replaced. A caller holding a `PersonaAgent`
 * has to be edited again when the loop behind it changes; a caller holding a
 * `TurnRunner` asked for a turn and does not know what ran it. That is the whole
 * point of the seam, and it only pays once nobody reaches past it.
 *
 * ## One runner per turn, and why that is not waste
 *
 * The agent is built here, once, and it reads its prior messages once. A caller that
 * held one runner across a whole conversation would be running every turn against the
 * transcript the first one started from. Building a runner is assembling options and
 * constructing an object, so the cost is nothing next to the model call it wraps, and
 * the per-turn things a session actually varies, what the persona currently knows,
 * what the environment just changed, are read fresh each time rather than frozen at
 * whatever they were when the session opened.
 */

import { PersonaAgent, type AgentOptions } from "../agent.js";
import { readAgentBudget } from "../governance.js";
import { readVerification } from "../verification.js";
import type { Ledger } from "./budget.js";
import type { Conversation } from "./conversation.js";
import { defaultLoop } from "./default-provider.js";
import { TurnRunner, type TurnObserver } from "./service.js";

/** The options this file answers, so nobody has to answer them twice. */
type Derived = "llm" | "budget" | "verification" | "judge" | "personaPath";

/**
 * What the persona says about itself.
 *
 * Taken already-read rather than loaded here, because reading is the caller's
 * business: the REPL has the file open, the SDK holds a handle, and a hosted runner
 * may have neither. What this needs is the answers, not the path to them.
 */
export interface PersonaFacts {
	readonly personaPath: string;
	readonly frontmatter: Record<string, unknown>;
	/** The model it declared, already resolved. */
	readonly llm: AgentOptions["llm"];
}

/**
 * Everything else, which is the caller's by definition.
 *
 * `priorMessages` is not among them, and its absence is deliberate. A conversation the
 * caller passes in and a conversation the caller reads back out are the same fact, and
 * two ways to say it is two owners: a session could hand one transcript to the loop and
 * keep a different one for itself with nothing to say which was the conversation. So
 * the session lends a `Conversation` and the loop both reads and returns through it.
 */
export type SessionOptions = Omit<AgentOptions, Derived | "priorMessages"> & {
	readonly ledger?: Ledger;
	readonly observer?: TurnObserver;
	/** What has been said, lent to whatever runs the turn. */
	readonly conversation?: Conversation;
};

/**
 * The options, derived, as a value.
 *
 * Separate from the assembly so the derivation can be checked without a model and
 * without reaching past the seam. A test that could only assert this by reading a
 * private field would be a test that breaks the encapsulation it exists to protect,
 * and one that asserts something easier instead is worse: it passes while saying
 * nothing, under a name that claims otherwise.
 */
export function agentOptionsFor(
	persona: PersonaFacts,
	session: Omit<SessionOptions, "ledger" | "observer"> = {},
): AgentOptions {
	const { conversation, ...rest } = session;

	return {
		...rest,
		// Read here rather than by the caller, so "what the loop is given" and "what the
		// session holds" cannot be two different lists.
		...(conversation === undefined ? {} : { priorMessages: [...conversation.read()] }),
		llm: persona.llm,
		personaPath: persona.personaPath,
		budget: readAgentBudget(persona.frontmatter),
		verification: readVerification(persona.frontmatter),
		// The judge is the persona's own model. A separate one would mean a persona
		// checked by something it never declared, which is a claim its spec cannot
		// support and nobody could audit from the file.
		judge: persona.llm,
	};
}

export function runnerFor(persona: PersonaFacts, session: SessionOptions = {}): TurnRunner {
	const { ledger, observer, ...rest } = session;

	return new TurnRunner({
		provider: defaultLoop(new PersonaAgent(agentOptionsFor(persona, rest)), rest.conversation),
		...(ledger === undefined ? {} : { ledger }),
		...(observer === undefined ? {} : { observer }),
	});
}
