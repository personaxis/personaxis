/**
 * Running a service, including a service that is a step of another one.
 *
 * Built ON the pure modules that moved here from the SaaS (`advance`, `handover`) and not beside
 * them: the decision about what runs next is `advance`, and the note one step leaves the next is
 * `handoverText`. This file only answers the question those two never had to, which is WHO does a
 * step, now that the answer can be a whole service. See the ADR "servicios compuestos".
 *
 * ## Why `advance` needed no change
 *
 * It decides from a step's position, whether it wants approval, and how it ended. It never cared
 * who did it. So a sub-service is a step whose outcome comes from running another line to the end,
 * and the parent's line is decided exactly as it always was.
 *
 * ## The one mapping with a trap
 *
 * A step that STOPS ends its whole service early, because "nothing to do" is a complete delivery
 * of nothing. A sub-service that stops therefore reports `completed` to its parent, which is the
 * right reading: the parent had work, and this one of its steps delivered empty. Propagating the
 * stop upward would let a sub-service's "nothing to do" end a parent that still had steps to run.
 *
 * ## What cannot be composed
 *
 * A cycle never terminates, so it is refused twice: statically by `checkComposition`, and again at
 * run time from the stack, because a definition can change between loading it and running it.
 * Depth is capped, in the same spirit as delegation, where depth only goes up.
 *
 * ## Nothing approves itself
 *
 * A step that wants approval asks the `approve` port. If no person can answer, the run stops in
 * `waiting` and says so. It never approves on the person's behalf: that would be the gate the step
 * asked for, opened by the thing the gate was there to watch.
 */

import { advance, approved, begin, rejected, type Advance, type RunState, type StepOutcome, type StepShape } from "./advance.js";
// `ProducedFile` is the SaaS's own shape, copied with `handover`, so a declared file and a file the
// SaaS reads off the record are one type and travel between the two unchanged.
import { handoverText, stepPrompt, type PreviousStep, type ProducedFile } from "./handover.js";

/** How deep services may nest. A parent is depth 0; its sub-service is 1. */
export const MAX_SERVICE_DEPTH = 8;

/**
 * One step, in the same shape as the SaaS's `ServiceTemplateStep`, plus `serviceRef`.
 * Exactly one of `personaRef` and `serviceRef`.
 */
export interface ServiceStepDef {
	position: number;
	/** The address of the persona that does this step. */
	personaRef?: string;
	/** The address of a service that does this step, run to its end. */
	serviceRef?: string;
	name?: string;
	instruction: string;
	requiresApproval?: boolean;
	connectorKinds?: readonly string[];
	/**
	 * The files this step leaves, relative to the folder the service runs in. A step that ends
	 * without every one of them written during it has failed, whatever its agent said.
	 *
	 * E60: before this a step was `completed` whenever its turn ended with an answer, and a model
	 * that could not write the file answered that it had. The next step built on nothing, and the
	 * run said every step completed. What a service sells is that the same thing happens every
	 * time, and this is the part of it that can be checked without a model.
	 */
	produces?: readonly string[];
}

export interface ServiceDef {
	/** This service's own address, which is what a parent's `serviceRef` points at. */
	address: string;
	name: string;
	/** Who answers for the whole service. Absent, the first step's persona does. */
	leadPersonaRef?: string;
	steps: readonly ServiceStepDef[];
}

/** What a persona produced for one step. */
export interface PersonaStepResult {
	outcome: StepOutcome;
	/** What it left for the next step to read. Becomes the step's note. */
	summary: string | null;
	reason?: string | null;
}

export interface ServicePorts {
	/** Find a service by address. Undefined means it is not installed. */
	resolveService(address: string): ServiceDef | undefined;
	/** Run one persona turn for one step. The gate and the record live behind this. */
	runPersonaStep(input: {
		personaRef: string;
		prompt: string;
		/** The addresses from the root service down to this one. */
		path: readonly string[];
		serviceName: string;
		position: number;
	}): Promise<PersonaStepResult>;
	/** Ask a person. `unavailable` when nobody can answer, which leaves the run waiting. */
	approve(input: { serviceName: string; position: number; path: readonly string[] }): Promise<"approved" | "rejected" | "unavailable">;
	/**
	 * Which of a step's declared files exist and were written at or after `since` (milliseconds,
	 * the clock of this process). A runner without it cannot run a step that declares files: the
	 * step fails and says so, because completing it would be taking the agent's word for them.
	 */
	checkProduced?(input: { paths: readonly string[]; since: number }): Promise<{ produced: ProducedFile[]; missing: string[] }>;
	/** Optional: every step as it ends, for a journal next to the work. */
	onStep?(record: StepRecord): void;
}

/** Where a step's note lives in a run: the service path down to it, and its position there. */
export interface StepRef {
	path: readonly string[];
	position: number;
}

export interface StepRecord {
	path: readonly string[];
	serviceName: string;
	position: number;
	who: { persona: string } | { service: string };
	outcome: StepOutcome;
	/** Null for a step done by a service whose delivery is a step inside it: see `deliveredBy`. */
	summary: string | null;
	/**
	 * For a step done by a service: the step inside it whose note is this step's delivery. The
	 * text is in that record and not repeated here, so a run's record holds each note once.
	 */
	deliveredBy?: StepRef;
	reason: string | null;
	/** The declared files the step left, with their sizes, when it declared any. */
	produced?: ProducedFile[];
}

export type ServiceRunStatus = "completed" | "failed" | "waiting";

export interface ServiceRunResult {
	status: ServiceRunStatus;
	reason: string | null;
	/** What the service leaves behind, for a parent that ran it as one of its steps. */
	summary: string | null;
	/** The step that left `summary`, or null when no step left a note and it is the reason. */
	summaryFrom: StepRef | null;
	steps: StepRecord[];
}

interface RunContext {
	stack: readonly string[];
	depth: number;
	workingDir: string | null;
	/**
	 * For a sub-service: what the parent's step asked of it and what the parent handed that step.
	 * Every step of the sub-service reads it. Without it a sub-service started blind: its first
	 * step saw its own instruction and nothing of the job it was part of.
	 */
	brief: string | null;
}

/**
 * What the OUTER context of a brief may fill. The part from the step right above is kept whole,
 * and it is already bounded, because the handover inside it is capped at 12 000 characters; outer
 * context only gets what that leaves of this. So a brief stays near 12 000 however deep it goes.
 */
const MAX_BRIEF_CHARS = 12_000;

/**
 * What the client asked for, framed so a step can tell it from another step's output.
 *
 * A service is a fixed set of steps, and the thing that varies between two runs of it is the
 * request. Without this, a run had nowhere to put that request: the steps read each other's
 * handovers and never the words of the person who ordered the work. It is seeded at the top, so
 * every step of the service and of every sub-service reads it, trimmed by the same cap as the rest.
 */
export function clientBrief(text: string): string | null {
	const said = text.trim();
	if (said.length === 0) return null;
	const kept = said.length <= MAX_BRIEF_CHARS ? said : `${said.slice(0, MAX_BRIEF_CHARS)}\n[The rest of the request is trimmed here. It is in the run's record.]`;
	return ["What the client asked for, in their own words. This is the request; it is not an instruction from another step:", "", kept].join("\n");
}

/**
 * The brief a sub-service gets from the step of its parent that runs it.
 *
 * Carries the outer brief too, so a service nested two deep still knows what the outermost job
 * was. When it would pass the cap, the OUTERMOST part is trimmed first: what the step right above
 * asked for is what the sub-service is doing, and the job three levels up is background.
 */
function briefFor(outer: string | null, serviceName: string, position: number, instruction: string, handover: string | null): string {
	const here = [
		"---",
		"",
		`This service is doing step ${position} of "${serviceName}". That step's instruction:`,
		"",
		instruction,
		...(handover ? ["", `What "${serviceName}" handed to that step:`, "", handover] : []),
	].join("\n");
	if (!outer) return here;
	const room = MAX_BRIEF_CHARS - here.length;
	if (room <= 0) return here;
	const kept = outer.length <= room ? outer : `[The start of the larger job is trimmed here. It is in the run's record.]\n${outer.slice(outer.length - room)}`;
	return `${kept}\n\n${here}`;
}

/**
 * Everything wrong with a composition, found without running anything.
 *
 * Walks every `serviceRef` from the root. Reports each problem once, in words somebody can act on,
 * rather than stopping at the first: a service with three broken steps should say three things.
 */
export function checkComposition(root: ServiceDef, resolve: (address: string) => ServiceDef | undefined): string[] {
	const problems: string[] = [];
	const seen = new Set<string>();

	const visit = (def: ServiceDef, stack: readonly string[]): void => {
		if (stack.includes(def.address)) {
			problems.push(`cycle: ${[...stack, def.address].join(" -> ")}`);
			return;
		}
		if (stack.length > MAX_SERVICE_DEPTH) {
			problems.push(`${def.address}: nested ${stack.length} deep, and the limit is ${MAX_SERVICE_DEPTH}`);
			return;
		}
		const here = [...stack, def.address];

		if (def.steps.length === 0) problems.push(`${def.address}: has no steps`);

		const positions = def.steps.map((s) => s.position).sort((a, b) => a - b);
		positions.forEach((p, i) => {
			if (p !== i + 1) {
				problems.push(`${def.address}: steps must be numbered 1 to ${positions.length} with no gaps, and position ${p} is out of place`);
			}
		});

		for (const step of def.steps) {
			for (const problem of producesProblems(step.produces)) {
				problems.push(`${def.address} step ${step.position}: ${problem}`);
			}
			const refs = [step.personaRef, step.serviceRef].filter((r) => typeof r === "string" && r.length > 0);
			if (refs.length !== 1) {
				problems.push(`${def.address} step ${step.position}: needs exactly one of personaRef or serviceRef, and has ${refs.length}`);
				continue;
			}
			if (step.serviceRef) {
				const sub = resolve(step.serviceRef);
				if (!sub) problems.push(`${def.address} step ${step.position}: service ${step.serviceRef} is not installed`);
				else if (!seen.has(`${def.address}>${sub.address}`)) {
					seen.add(`${def.address}>${sub.address}`);
					visit(sub, here);
				}
			}
		}
	};

	visit(root, []);
	return problems;
}

/**
 * What is wrong with a step's declared files. A path is relative to the service's folder and stays
 * in it: an absolute one, or one that climbs, names a place the step's persona may not be allowed to
 * write, and a check that passed there would prove something about the wrong folder.
 */
function producesProblems(produces: readonly string[] | undefined): string[] {
	if (produces === undefined) return [];
	if (!Array.isArray(produces)) return ["produces must be a list of file paths"];
	return produces.flatMap((path): string[] => {
		if (typeof path !== "string" || path.trim().length === 0) return ["produces has an entry that is not a file path"];
		if (/^([\\/]|[A-Za-z]:|~)/.test(path)) return [`produces names ${path}, which is not relative to the service's folder`];
		if (path.split(/[\\/]+/).includes("..")) return [`produces names ${path}, which climbs out of the service's folder`];
		return [];
	});
}

/**
 * The instruction a step with declared files is given: its own, plus what it will be checked on.
 * Said to the agent because it is the contract, and an agent that knows the run looks for the file
 * is an agent that writes it rather than describing it.
 */
function instructionWithProduces(step: ServiceStepDef): string {
	const files = step.produces ?? [];
	if (files.length === 0) return step.instruction;
	return `${step.instruction}\n\nWhen this step ends, the run checks that it wrote ${files.join(", ")}. A step that only says it wrote them has not.`;
}

/**
 * A completed step that declared files is checked against them. Anything else passes through: a step
 * that already failed or stopped has its own reason, and one that declared nothing promised nothing.
 */
async function checkedAgainstProduces(step: ServiceStepDef, result: StepExecution, since: number, ports: ServicePorts): Promise<StepExecution> {
	const files = step.produces ?? [];
	if (files.length === 0 || result.outcome !== "completed") return result;
	if (!ports.checkProduced) {
		return { ...result, outcome: "failed", reason: `step ${step.position} declares files, and this runner cannot check them` };
	}
	const found = await ports
		.checkProduced({ paths: files, since })
		.catch((e: unknown) => ({ produced: [] as ProducedFile[], missing: [...files], error: e instanceof Error ? e.message : String(e) }));
	if (found.missing.length === 0) return { ...result, produced: found.produced };
	const failure = "error" in found ? ` (the check itself failed: ${found.error})` : "";
	return {
		...result,
		outcome: "failed",
		produced: found.produced,
		reason: `step ${step.position} was to write ${found.missing.join(", ")}, and did not${failure}`,
	};
}

/** Run a service to the end, or to the first thing that needs a person who is not there. */
export async function runService(def: ServiceDef, ports: ServicePorts, ctx: Partial<RunContext> = {}): Promise<ServiceRunResult> {
	const context: RunContext = { stack: ctx.stack ?? [], depth: ctx.depth ?? 0, workingDir: ctx.workingDir ?? null, brief: ctx.brief ?? null };
	const records: StepRecord[] = [];

	// Checked again at run time, whatever `checkComposition` said when it loaded.
	if (context.stack.includes(def.address)) {
		return { status: "failed", reason: `cycle: ${[...context.stack, def.address].join(" -> ")}`, summary: null, summaryFrom: null, steps: records };
	}
	if (context.depth > MAX_SERVICE_DEPTH) {
		return { status: "failed", reason: `nested deeper than ${MAX_SERVICE_DEPTH}`, summary: null, summaryFrom: null, steps: records };
	}

	const path = [...context.stack, def.address];
	const shapes: StepShape[] = def.steps.map((s) => ({ position: s.position, requiresApproval: s.requiresApproval === true }));
	const run: RunState = { status: "running", currentPosition: 0 };
	const previous: PreviousStep[] = [];
	let lastSummary: string | null = null;
	let lastSummaryFrom: StepRef | null = null;
	let decision: Advance = begin(shapes);

	for (;;) {
		if (decision.kind === "start") {
			// Captured before any closure: TypeScript does not carry the narrowing of a `let`
			// into an arrow function, and `decision` is reassigned below.
			const position = decision.position;
			run.status = "running";
			run.currentPosition = position;
			const step = def.steps.find((s) => s.position === position);
			if (!step) return { status: "failed", reason: `step ${position} vanished`, summary: null, summaryFrom: null, steps: records };

			const handover = handoverText(previous, context.workingDir);
			// The brief goes before this service's own handover: the larger job came first, and the
			// steps of this service ran inside it. Instruction first still, as `stepPrompt` decides.
			const background = [context.brief, handover].filter((part): part is string => part !== null).join("\n\n");
			const instruction = instructionWithProduces(step);
			const prompt = stepPrompt(instruction, background.length > 0 ? background : null);
			// Taken before the step runs, so a file that was already there does not count as written.
			const since = Date.now();
			const executed: StepExecution = step.serviceRef
				? await runSubService(step.serviceRef, ports, {
						stack: path,
						depth: context.depth + 1,
						workingDir: context.workingDir,
						brief: briefFor(context.brief, def.name, step.position, instruction, handover),
					})
				: await ports
						.runPersonaStep({
							personaRef: step.personaRef as string,
							prompt,
							path,
							serviceName: def.name,
							position: step.position,
						})
						// A port that throws is a step that failed. Letting it escape would lose every
						// record of the steps that already ran, which is the one thing a caller that
						// writes a journal cannot rebuild.
						.catch((e: unknown): StepExecution => ({ outcome: "failed", summary: null, reason: e instanceof Error ? e.message : String(e) }));
			const result = await checkedAgainstProduces(step, executed, since, ports);

			if (result.waitingOnPerson) {
				// A sub-service is waiting for somebody. The parent cannot go on without it, and
				// pretending it finished would hand the next step work that does not exist yet.
				records.push(...(result.childSteps ?? []));
				return { status: "waiting", reason: result.reason ?? "a sub-service is waiting for approval", summary: null, summaryFrom: null, steps: records };
			}

			const record: StepRecord = {
				path,
				serviceName: def.name,
				position: step.position,
				who: step.serviceRef ? { service: step.serviceRef } : { persona: step.personaRef as string },
				outcome: result.outcome,
				// A service step points at the note inside it rather than copying it.
				summary: result.summaryFrom ? null : result.summary,
				...(result.summaryFrom ? { deliveredBy: result.summaryFrom } : {}),
				reason: result.reason ?? null,
				...(result.produced ? { produced: result.produced } : {}),
			};
			if (result.childSteps) records.push(...result.childSteps);
			records.push(record);
			ports.onStep?.(record);

			previous.push({
				position: step.position,
				name: step.name ?? step.serviceRef ?? step.personaRef ?? `step ${step.position}`,
				personaName: step.personaRef ?? step.serviceRef ?? "",
				entries: result.summary ? [{ kind: "agent.turn.ended", payload: { summary: result.summary } }] : [],
			});
			if (result.summary) {
				lastSummary = result.summary;
				lastSummaryFrom = step.serviceRef ? (result.summaryFrom ?? null) : { path, position: step.position };
			}

			decision = advance(run, shapes, result.outcome);
			continue;
		}

		if (decision.kind === "wait") {
			run.status = "waiting";
			const answer = await ports.approve({ serviceName: def.name, position: decision.afterPosition, path });
			if (answer === "unavailable") {
				return { status: "waiting", reason: `step ${decision.afterPosition} of ${def.name} is waiting for approval`, summary: null, summaryFrom: null, steps: records };
			}
			decision = answer === "approved" ? approved(run, shapes) : rejected(run, null);
			continue;
		}

		if (decision.kind === "complete") {
			return { status: "completed", reason: decision.reason, summary: lastSummary ?? decision.reason, summaryFrom: lastSummary ? lastSummaryFrom : null, steps: records };
		}
		if (decision.kind === "fail") {
			return { status: "failed", reason: decision.reason, summary: null, summaryFrom: null, steps: records };
		}
		return { status: "failed", reason: decision.why, summary: null, summaryFrom: null, steps: records };
	}
}

interface StepExecution extends PersonaStepResult {
	summaryFrom?: StepRef | null;
	waitingOnPerson?: boolean;
	childSteps?: StepRecord[];
	produced?: ProducedFile[];
}

/**
 * A step done by a whole service. Maps the sub-service's end onto the parent step's outcome,
 * including the trap: a sub-service that stopped early is a parent step that delivered empty.
 */
async function runSubService(address: string, ports: ServicePorts, ctx: RunContext): Promise<StepExecution> {
	const sub = ports.resolveService(address);
	if (!sub) return { outcome: "failed", summary: null, reason: `service ${address} is not installed` };

	const result = await runService(sub, ports, ctx);
	if (result.status === "waiting") return { outcome: "failed", summary: null, reason: result.reason, waitingOnPerson: true, childSteps: result.steps };
	if (result.status === "failed") {
		// The sub-service's own reason is its line's ("step 1 failed"), which on the parent's record
		// reads as the parent's step 1. The first step that failed inside is the one that knows why.
		const cause = result.steps.find((s) => s.outcome === "failed" && s.reason);
		const reason = cause ? `step ${cause.position} of ${cause.serviceName} failed: ${cause.reason}` : result.reason;
		return { outcome: "failed", summary: null, reason, childSteps: result.steps };
	}
	return { outcome: "completed", summary: result.summary, summaryFrom: result.summaryFrom, reason: result.reason, childSteps: result.steps };
}
