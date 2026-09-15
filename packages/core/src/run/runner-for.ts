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

import { randomUUID } from "node:crypto";

import { PersonaAgent, type AgentOptions } from "../agent.js";
import { compile } from "../enforcement/policy-compile.js";
import { Kernel } from "../kernel/index.js";
import { delegateTool, MAX_DELEGATION_DEPTH } from "../tools/delegate.js";
import { useSkillTool } from "../tools/use-skill.js";
import { permissionsFor, TOOL_PERMISSIONS, TOOL_POINT } from "../tools/mounted.js";
import { policyFromPersona } from "../enforcement/policy-from-persona.js";
import { readAgentBudget } from "../governance.js";
import { readVerification } from "../verification.js";
import { resolveWebSearch, webSearchTool } from "../web/search.js";
import type { Ledger } from "./budget.js";
import type { Conversation } from "./conversation.js";
import { ledgerForChild, type DelegatedScope } from "./delegation.js";
import { localSkillsOf } from "./local-skills.js";
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
	/**
	 * How deep in a delegation this session already sits. Absent means a root.
	 *
	 * Read here rather than counted from the record, because a session is a live thing
	 * and the record is a chain of what happened: a resumed sub-task would have to find
	 * its own depth by folding, and `deepen` exists precisely because the answer must
	 * never come out smaller than it went in.
	 */
	readonly delegationDepth?: number;
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
	// Compiled once and read twice: the gate needs the executable form, and the
	// catalogue needs the posture it was compiled from. Two calls would be two
	// compilations of one document that could disagree.
	const compiled = compile(
		policyFromPersona(persona.frontmatter, { personaVersionId: persona.personaPath }),
	);

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
		// The persona's own limits, compiled once per turn.
		//
		// Derived here for the same reason as the budget beside it: what a persona may
		// never do is a property of who it is, identical for every caller, and a caller
		// that could pass it would be changing the persona without editing it. Until E2
		// nothing derived it on this path at all, so a persona running in our own loop
		// was governed by the environment's sandbox and by nothing it had declared.
		capability: compiled,
		// E12: what the persona may be OFFERED, derived from the posture it declared.
		//
		// Here for the same reason as the line above it: a posture is a property of who
		// the persona is, and it is already written down, so nobody should have to state
		// the same intent a second time as a list of permissions. A read-only persona
		// stops being handed a file writer it would only be refused for using.
		permissions: permissionsFor(compiled.policy.sandbox),
		// Web search, when this machine has a provider for it (2026-09-11). Added to whatever
		// the caller contributes rather than in place of it, and only with a key, so a persona
		// is never offered a search that fails on its first call. Not offered to a read-only
		// persona, whose posture refuses the network: the same rule as the file writer above.
		...webTools(rest.extraTools, compiled.policy.sandbox),
	};
}

/** The caller's contributed tools, plus `web_search` when a provider resolves and the posture allows the network. */
function webTools(contributed: AgentOptions["extraTools"], sandbox: string): { extraTools?: AgentOptions["extraTools"] } {
	const provider = sandbox === "read-only" ? undefined : resolveWebSearch();
	if (!provider) return contributed ? { extraTools: contributed } : {};
	return { extraTools: [...(contributed ?? []), webSearchTool(provider)] };
}

/**
 * The session a sub-task runs under, derived from its parent's.
 *
 * A named function rather than an object literal inside the tool's closure, and the
 * difference is that every rule below can be checked without a model. Each line here is
 * one of the study's findings, and the ones that are easy to get wrong are the ones a
 * caller would write by hand.
 */
export function subTaskSession(
	parent: SessionOptions,
	scope: DelegatedScope,
	statement: string,
): SessionOptions {
	// E84: the parent's way of reaching a person is dropped with its transcript. A sub-task that asks stops
	// at the question and hands it back up, which is P10 of E77 and the same rule as `onApproval` below: a
	// child never puts a prompt in front of whoever is at the keyboard.
	const { ledger, conversation: _parentTranscript, kernel: _parentKernel, onQuestion: _parentAsks, ...carried } = parent;

	return {
		...carried,
		delegationDepth: scope.depth,
		// A sub-task never asks. The rule is `delegation.ts`'s and this is the seam it
		// lands on: an `ask` verdict resolves to a denial, deterministically, so
		// widening stays a decision on the parent's side rather than a prompt in front
		// of whoever happens to be at the keyboard when it fires.
		//
		// C6b: with the reason, because the reference's measured failure was a child
		// blocked in a way nothing could see. A bare denial here would have been
		// written down as a person refusing, in a run where nobody was asked.
		onApproval: async () => ({
			decision: "deny" as const,
			reason:
				"a delegated sub-task cannot ask: widening its scope is its parent's decision, " +
				"so this ends with the limitation reported rather than queued",
		}),
		// The scope, told as runtime context and never as system prompt. Measured by the
		// reference: the same facts in a system prompt stopped the model attempting
		// anything at all, five turns of twelve ending with no tool call.
		envNote: statement,
		// Its own transcript, which is what dropping the parent's `conversation` means.
		// Lending it would put the sub-task's working-out into the conversation a person
		// is reading, and hand the sub-task a context that is not about its task.
		//
		// The parent's KERNEL is dropped for the neighbouring reason: a withdrawal
		// inside a sub-task must not reach into the catalogue its parent is still using.
		...(ledger === undefined ? {} : { ledger: ledgerForChild(ledger) }),
	};
}

export function runnerFor(persona: PersonaFacts, session: SessionOptions = {}): TurnRunner {
	const { ledger, observer, delegationDepth, ...rest } = session;

	// C6: the catalogue gets a way to hand work down.
	//
	// Mounted here and not inside the agent, because the tool needs something no tool
	// can have: a way to START a run. The agent assembles a catalogue; this function is
	// where a run is assembled, so this is the only place that can offer one without
	// the built-ins learning about runs.
	//
	// Through the kernel rather than through `tools`, which would REPLACE the
	// catalogue, or `extraTools`, which would skip the permission. A component that
	// declares what it requires is how a read-only persona ends up never being shown a
	// tool it would only be refused for using.
	const kernel = rest.kernel ?? new Kernel();

	// Assembled before the agent is built, because the agent mounts its catalogue in
	// its constructor and the photograph below reads what this derivation decided. Two
	// compilations of one document could disagree, which is the reason `agentOptionsFor`
	// gives for compiling once itself.
	const options = agentOptionsFor(persona, { ...rest, kernel });

	kernel.mount({
		name: "tool.delegate",
		requires: [TOOL_PERMISSIONS.delegate],
		activate: (context) => {
			context.contribute(
				TOOL_POINT,
				delegateTool({
					depth: () => delegationDepth ?? 0,
					// What the persona narrowed for ITSELF: its declared posture, read
					// from the policy compiled out of its own document rather than from
					// the environment's. Directories are absent and that is measured, not
					// forgotten: on 2026-09-08 nothing in `policyFromPersona` reads a
					// directory, so a list here would be a photograph of something nobody
					// ever took.
					scope: () => ({
						...(options.capability === undefined
							? {}
							: { sandbox: options.capability.policy.sandbox }),
					}),
					maxDepth: MAX_DELEGATION_DEPTH,
					run: async ({ instruction, scope, statement }) => {
						const outcome = await runnerFor(persona, subTaskSession(session, scope, statement)).run({
							turn: randomUUID(),
							prompt: instruction,
							// A persona asked for this turn, which is the one kind of asker
							// the vocabulary already had and nothing ever produced.
							asker: { kind: "persona", id: persona.personaPath },
							delegation: scope,
						});

						return {
							answer: outcome.answer,
							stopReason: outcome.stopReason,
							steps: outcome.steps,
						};
					},
				}),
			);
		},
	});

	// E72: a persona loads its own skills. Mounted here, beside delegation, because what a persona has
	// is read from its folder and this is where a run is assembled, so the TUI, an editor over ACP and a
	// service step all get it from one place. Only when there is something to load: a tool that can only
	// ever answer "you have no skills" is catalogue noise a small model will try anyway.
	if (localSkillsOf(persona.personaPath, persona.frontmatter).skills.length > 0) {
		kernel.mount({
			name: "tool.use-skill",
			requires: [TOOL_PERMISSIONS.readFiles],
			activate: (context) => {
				context.contribute(TOOL_POINT, useSkillTool({ skills: () => localSkillsOf(persona.personaPath, persona.frontmatter).skills }));
			},
		});
	}

	return new TurnRunner({
		provider: defaultLoop(new PersonaAgent(options), rest.conversation),
		...(ledger === undefined ? {} : { ledger }),
		...(observer === undefined ? {} : { observer }),
	});
}
