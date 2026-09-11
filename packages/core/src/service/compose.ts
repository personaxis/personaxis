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
import { handoverText, stepPrompt, type PreviousStep } from "./handover.js";

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
			const prompt = stepPrompt(step.instruction, background.length > 0 ? background : null);
			const result: StepExecution = step.serviceRef
				? await runSubService(step.serviceRef, ports, {
						stack: path,
						depth: context.depth + 1,
						workingDir: context.workingDir,
						brief: briefFor(context.brief, def.name, step.position, step.instruction, handover),
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
	if (result.status === "failed") return { outcome: "failed", summary: null, reason: result.reason, childSteps: result.steps };
	return { outcome: "completed", summary: result.summary, summaryFrom: result.summaryFrom, reason: result.reason, childSteps: result.steps };
}
