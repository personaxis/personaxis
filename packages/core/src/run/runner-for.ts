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
import { existsSync } from "node:fs";

import { PersonaAgent, type AgentOptions } from "../agent.js";
import { resolveModel } from "../model-config.js";
import { DEFAULT_POLICY } from "../sandbox.js";
import { assemble, identityOf } from "./assembled.js";
import { colleaguePathFor, colleaguesOf, lowerCeiling, type Ceiling } from "./colleagues.js";
import { wordlessReport } from "./wordless.js";
import { lessonFrom } from "./lesson-extract.js";
import { requestToolCall } from "../tool-calling.js";
import type { Lesson, PostmortemInput } from "../postmortem.js";
import { compile } from "../enforcement/policy-compile.js";
import { Kernel } from "../kernel/index.js";
import { delegateTool, MAX_DELEGATION_DEPTH } from "../tools/delegate.js";
import { useSkillTool } from "../tools/use-skill.js";
import { runServiceTool, type RunServiceInput } from "../tools/run-service.js";
import { permissionsFor, TOOL_PERMISSIONS, TOOL_POINT } from "../tools/mounted.js";
import { policyFromPersona } from "../enforcement/policy-from-persona.js";
import { regulationFor } from "./regulation.js";
import { readAgentBudget } from "../governance.js";
import { readVerification } from "../verification.js";
import { resolveWebSearch, webSearchTool } from "../web/search.js";
import type { Ledger } from "./budget.js";
import type { Conversation } from "./conversation.js";
import { ledgerForChild, type DelegatedScope } from "./delegation.js";
import { localSkillsOf } from "./local-skills.js";
import { renderWorkMap, workMapFor } from "./work-map.js";
import { inspectSelfTool } from "../tools/inspect-self.js";
import { howYouAreNow } from "../moment.js";
import { loadPersona, readState } from "../persona.js";
import { activeOverlay, applyOverlay } from "../self-evolution.js";
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
	/**
	 * E73: the host's way to run one of the persona's services to its end, lent to a turn that may start one.
	 *
	 * Absent means nobody here can run a service, and then the persona is not shown `run_service` at all. The
	 * TUI lends it; a service step and a delegated sub-task never have it, so a service cannot start another
	 * from inside a turn.
	 */
	readonly runService?: (input: RunServiceInput) => Promise<string>;
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
	//
	// E126: the posture the gate holds is at least what the persona's own record calls for, when its declared
	// self-regulation says a person should step in. Only the compiled gate: the session's policy is the one the
	// scope line prints to the model, and telling a model it has been failing was measured to break it.
	const regulation = regulationFor(persona.personaPath, persona.frontmatter as Record<string, unknown>);
	const compiled = compile(
		policyFromPersona(persona.frontmatter, {
			personaVersionId: persona.personaPath,
			...(regulation.approval === undefined
				? {}
				: { approvalAtLeast: { approval: regulation.approval, because: regulation.because.join("; and ") } }),
		}),
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

/**
 * E119: how the persona is right now, the bands that differ from its identity, read from the state on disk the way the
 * loop's own moment reads it. Empty on any failure: this is something to look at, never something that breaks a turn.
 */
function nowOf(personaPath: string, identity: string | undefined): string {
	if (!identity) return "";
	try {
		const handle = loadPersona(personaPath);
		if (!existsSync(handle.statePath)) return "";
		const current = applyOverlay(handle.frontmatter as Record<string, unknown>, activeOverlay(personaPath));
		return howYouAreNow(identity, current, readState(handle.statePath).values);
	} catch {
		return "";
	}
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
	// child never puts a prompt in front of whoever is at the keyboard. E73: nor its way to run a service, which
	// asks that same person before every run.
	const { ledger, conversation: _parentTranscript, kernel: _parentKernel, onQuestion: _parentAsks, runService: _parentRuns, ...carried } = parent;

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

/**
 * E87: a colleague as a persona that can run, from the address its asker named.
 *
 * Its own document and its own model, because a colleague is somebody else: reading the asker's spec into it
 * would make "hand this to the lawyer" mean "do it yourself in a different folder". The asker's model is the
 * fallback and only that, for a colleague whose settings declare none, because a persona with a thin config
 * should not become unreachable; what it declares always wins.
 *
 * Undefined when the address resolves to nothing on disk. The tool has already checked it against the map, so
 * this is the second half of the same guard: between the check and the run, a folder can be gone.
 */
function colleagueFor(asking: PersonaFacts, address: string): { readonly facts: PersonaFacts; readonly identity: string } | undefined {
	const path = colleaguePathFor(asking.personaPath, address);
	if (path === undefined || !existsSync(path)) return undefined;
	const read = assemble(path);
	const own = resolveModel({ personaPath: read.personaPath, frontmatter: read.frontmatter });
	return {
		facts: { personaPath: read.personaPath, frontmatter: read.frontmatter, llm: (own ?? asking.llm) as PersonaFacts["llm"] },
		// Its own document, or its own spec body when it has never been compiled. Without this the colleague
		// would be handed the asker's identity, because a sub-task session carries `personaBody` through.
		identity: identityOf(read),
	};
}

/**
 * O22: the session a colleague works in, which is the sub-task session with the policy narrowed.
 *
 * The lower ceiling of the two, on both axes, landing on the executable policy the session lends. That is the
 * half a caller decides: the colleague's own compiled document is recompiled by `agentOptionsFor` and applies
 * on top of this through `capabilityGuard`, and no caller can loosen it. So the colleague ends up under the
 * lower of the two ceilings and under its own rules as well, which is least privilege rather than a
 * negotiation between two specs.
 */
function ceilingFor(child: SessionOptions, colleague: PersonaFacts): Ceiling {
	const asking = child.policy ?? DEFAULT_POLICY;
	const declared = policyFromPersona(colleague.frontmatter, { personaVersionId: colleague.personaPath });
	return lowerCeiling(
		{ sandbox: asking.sandbox, approval: asking.approval },
		{ sandbox: declared.sandbox, approval: declared.approval },
	);
}

/** The same ceiling, applied to the policy the session lends. Computed once next door, so the two cannot disagree. */
function underLowerCeiling(child: SessionOptions, ceiling: Ceiling): SessionOptions {
	const asking = child.policy ?? DEFAULT_POLICY;
	return { ...child, policy: { ...asking, sandbox: ceiling.sandbox, approval: ceiling.approval } };
}

export function runnerFor(persona: PersonaFacts, session: SessionOptions = {}): TurnRunner {
	const { ledger, observer, delegationDepth, runService, ...rest } = session;

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
	// E88: the run reflects, and only the run somebody asked for.
	//
	// `agentOptionsFor` builds the options for EVERY run, and `subTaskSession` carries them through, so wiring
	// this without the depth check would have a round (`E86`) or a colleague (`E87`) writing skills of its own:
	// one turn could leave several, each abstracted from a piece nobody asked about on its own. The parent's
	// turn is the unit of work a person asked for, so that is the one that learns from itself.
	//
	// Nothing changes for a persona that declared no `improvement_policy`: `readMode` answers `locked` and the
	// draft is never written.
	const options =
		(delegationDepth ?? 0) > 0
			? agentOptionsFor(persona, { ...rest, kernel })
			: agentOptionsFor(persona, { ...rest, kernel, postmortem: { extract: lessonFrom(persona.llm) } });

	kernel.mount({
		name: "tool.delegate",
		requires: [TOOL_PERMISSIONS.delegate],
		activate: (context) => {
			context.contribute(
				TOOL_POINT,
				delegateTool({
					depth: () => delegationDepth ?? 0,
					// E87: the colleagues the persona's own map already shows it, read when the tool is CALLED
					// rather than when the catalogue was built, for the reason `depth` and `scope` are: a
					// sub-persona added while a session is open should be reachable, and one that was removed
					// should not be offered as an address that resolves to nothing.
					colleagues: () => colleaguesOf(persona.personaPath),
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
					run: async ({ instruction, scope, statement, to }) => {
						// E87: who does the work, and under what. With no address this is what it always was, a
						// sub-task of the same persona. With one, somebody else does it, under the lower of the two
						// ceilings. A colleague that has gone since the tool checked the map is reported rather than
						// quietly run as the asker, which would be the asker doing the work it decided to give away.
						const colleague = to === undefined ? undefined : colleagueFor(persona, to);
						if (to !== undefined && colleague === undefined) {
							return { answer: `There is no persona at ${to} any more, so nothing ran.`, stopReason: "refused", steps: 0 };
						}
						const child = subTaskSession(session, scope, statement);
						// O22: computed once, and used for BOTH the policy the colleague works under and the photograph that
						// travels with it. Two computations of one ceiling could disagree, and the photograph is what the record
						// writes down and what the child is told about its own limits.
						const ceiling = colleague === undefined ? undefined : ceilingFor(child, colleague.facts);
						// Described by its own document, never by the asker's: `subTaskSession` carries `personaBody` through,
						// which is right for a sub-task of the same persona and wrong for somebody else.
						const under =
							colleague === undefined || ceiling === undefined
								? child
								: { ...underLowerCeiling(child, ceiling), personaBody: colleague.identity };
						// What the child runs with. Anything that rides on the MODEL config reaches it untouched:
						// `subTaskSession` drops capabilities and never looks at the model, which on 2026-09-17 let
						// every child inherit `rounds: true` and open four of its own, 14 turns and 11 rounds in one
						// job at six times the tokens. `E86` retired that setting on 2026-09-21, and the seam it
						// exposed is still here: a model-level switch that makes a turn expensive multiplies down
						// this line, so anything added there is decided for the child too, on purpose or by default.
						const childFacts = colleague?.facts ?? persona;
						const outcome = await runnerFor(childFacts, under).run({
							turn: randomUUID(),
							prompt: instruction,
							// A persona asked for this turn, which is the one kind of asker the vocabulary already had.
							asker: { kind: "persona", id: persona.personaPath },
							// The applied ceiling, with who it went to, so the record and the child's own statement agree.
							delegation:
								ceiling === undefined || to === undefined
									? scope
									: { ...scope, inherited: { ...scope.inherited, sandbox: ceiling.sandbox }, to, approval: ceiling.approval },
						});

						return {
							// E99: a sub-task that worked and then said nothing still tells its parent what it did. Measured on
							// 2026-09-16: three of four sub-tasks closed answered after four steps with no answer, and all of
							// their work was invisible, because the only thing that crosses a delegation is the answer. Here
							// and not in the loop: the loop cannot tell a sub-task from a turn somebody is watching, and this
							// closure only ever runs for sub-tasks. Facts the runtime already holds, never invented prose.
							answer: outcome.answer || wordlessReport(outcome) || "",
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

	// E73: a persona runs a service it delivers, when the host lends a way to run one and there is one to run.
	// Beside `use_skill` for the same reason, and behind the write permission, because a service's steps write
	// files: a read-only persona is never shown a tool it would only be refused for using. What it delivers is
	// read with the same function as its index, so the tool and the index cannot disagree about it.
	const workspaceRoot = rest.policy?.workspaceRoot ?? process.cwd();
	const delivered = () => workMapFor(persona.personaPath, { workspaceRoot, frontmatter: persona.frontmatter }).services;
	if (runService !== undefined && delivered().length > 0) {
		kernel.mount({
			name: "tool.run-service",
			requires: [TOOL_PERMISSIONS.writeFiles],
			activate: (context) => {
				context.contribute(TOOL_POINT, runServiceTool({ services: delivered, run: runService }));
			},
		});
	}

	// E119: the persona looks at itself when it is about to say what it can do. The same map as its index,
	// from the same function, and how it is right now, both read when the tool is CALLED. Only when there is
	// something to show, for the same reason `use_skill` is: a tool that can only answer "nothing" is noise.
	const mapNow = () => workMapFor(persona.personaPath, { workspaceRoot, frontmatter: persona.frontmatter });
	const shown = mapNow();
	if (shown.skills.length + shown.services.length + shown.references.length > 0) {
		kernel.mount({
			name: "tool.inspect-self",
			requires: [TOOL_PERMISSIONS.readFiles],
			activate: (context) => {
				context.contribute(
					TOOL_POINT,
					inspectSelfTool({
						has: () => renderWorkMap(mapNow(), { canRunServices: runService !== undefined }),
						now: () => nowOf(persona.personaPath, rest.personaBody),
					}),
				);
			},
		});
	}

	return new TurnRunner({
		provider: defaultLoop(new PersonaAgent(options), rest.conversation),
		...(ledger === undefined ? {} : { ledger }),
		...(observer === undefined ? {} : { observer }),
	});
}
