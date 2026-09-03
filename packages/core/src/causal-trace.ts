/**
 * G6 / J.7: the causal trace, so "why did it do that" has an answer.
 *
 * A record already says what happened, in order. That answers "what", and people almost
 * never ask "what". They ask why a particular command ran, and the honest answer lives
 * across three things the record currently keeps as unrelated entries: the plan step that
 * intended it, the tool calls that carried it out, and the verification that decided whether
 * it worked.
 *
 * Linking them AT WRITE TIME rather than reconstructing later is the entire design decision,
 * and it is not for performance. A reconstruction is a guess: it matches a tool call to the
 * nearest plan step by time or by proximity in the log, which is right until a step retries,
 * or two run concurrently, or the model does something out of order. Then the trace confidently
 * attributes an action to an intention it never had, in a document whose value is that it can
 * be trusted. A wrong causal link is worse than no causal link.
 *
 * So: a step id travels with the work. What cannot be linked says so.
 */

/** Where an action came from. */
export interface Causality {
	/** The plan step this belongs to, when the run had a plan. */
	planStep?: number;
	/** The tool call id, tying a proposal to its verdict and its result. */
	callId?: string;
}

export type TraceNodeKind = "plan-step" | "tool-call" | "verification";

export interface TraceNode {
	kind: TraceNodeKind;
	seq: number;
	label: string;
	/** Set for anything that happened because of a plan step. */
	planStep?: number;
	callId?: string;
	ok?: boolean;
}

export interface TraceStep {
	planStep: number;
	intent: string;
	calls: TraceNode[];
	verification?: TraceNode;
	/** True when every call under it succeeded and verification did not fail. */
	ok: boolean;
}

export interface CausalTrace {
	steps: TraceStep[];
	/**
	 * Nodes that belong to no plan step.
	 *
	 * Kept and named rather than dropped or guessed at. A run where the model deviated from
	 * its plan is exactly the run somebody is investigating, and a trace that quietly filed
	 * those actions under the nearest step would hide the deviation while looking complete.
	 */
	unattributed: TraceNode[];
}

/**
 * Assemble a trace from record nodes.
 *
 * Attribution is by explicit `planStep`, never by proximity. Two calls that happen to sit
 * next to a plan step in the log are two calls that happen to sit next to it.
 */
export function buildTrace(intents: ReadonlyMap<number, string>, nodes: readonly TraceNode[]): CausalTrace {
	const steps = new Map<number, TraceStep>();
	for (const [planStep, intent] of intents) {
		steps.set(planStep, { planStep, intent, calls: [], ok: true });
	}

	const unattributed: TraceNode[] = [];

	for (const node of [...nodes].sort((a, b) => a.seq - b.seq)) {
		if (node.kind === "plan-step") continue;

		const step = node.planStep !== undefined ? steps.get(node.planStep) : undefined;
		if (!step) {
			unattributed.push(node);
			continue;
		}

		if (node.kind === "verification") {
			step.verification = node;
			if (node.ok === false) step.ok = false;
			continue;
		}

		step.calls.push(node);
		if (node.ok === false) step.ok = false;
	}

	return { steps: [...steps.values()].sort((a, b) => a.planStep - b.planStep), unattributed };
}

/**
 * The trace, in words, for a person asking why something happened.
 *
 * A step with no calls is stated rather than omitted: "the plan said to do this and nothing
 * happened" is usually the answer somebody is looking for, and an empty section conveys it
 * where a missing section conveys nothing.
 */
export function describeTrace(trace: CausalTrace): string {
	const lines: string[] = [];

	for (const step of trace.steps) {
		lines.push(`${step.planStep}. ${step.intent} — ${step.ok ? "ok" : "did not complete"}`);

		if (step.calls.length === 0) {
			lines.push("     nothing ran for this step");
		} else {
			for (const call of step.calls) {
				lines.push(`     ${call.label}${call.ok === false ? " (failed)" : ""}`);
			}
		}

		if (step.verification) {
			lines.push(`     verified: ${step.verification.label}${step.verification.ok === false ? " (failed)" : ""}`);
		}
	}

	if (trace.unattributed.length > 0) {
		lines.push("", "Not part of the plan:");
		for (const node of trace.unattributed) {
			lines.push(`     ${node.label}`);
		}
		lines.push("A run that departed from its plan is worth reading closely; these were not guessed into a step.");
	}

	return lines.join("\n");
}

/**
 * Which plan step a call belongs to, when the plan makes that unambiguous.
 *
 * The header of this file forbids attributing by proximity, and this is not that. A plan
 * step declares the TOOL it intends to use, so a call to that tool is either the step
 * that named it or it is not part of the plan at all. That is identity, not nearness.
 *
 * The ambiguity rule is where the whole thing is decided. When two steps declare the
 * same tool, a call to it could be either, and picking the earlier one would be a guess
 * dressed as a fact. So the answer is nothing, and the call lands under "not part of the
 * plan", which reads as uncertain rather than as wrong. A wrong causal link is worse
 * than no causal link, in a document whose value is that it can be trusted.
 *
 * Returns a map from tool name to step number, holding only the unambiguous ones.
 */
export function unambiguousSteps(plan: readonly { readonly tool: string }[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const step of plan) counts.set(step.tool, (counts.get(step.tool) ?? 0) + 1);

	const attributable = new Map<string, number>();
	plan.forEach((step, index) => {
		if (counts.get(step.tool) === 1) attributable.set(step.tool, index + 1);
	});
	return attributable;
}

/**
 * Whether a trace is worth attaching to a post-mortem.
 *
 * A trace of a run that went exactly to plan tells a reflecting persona nothing it does not
 * already have from the outcome. What is worth reading is a step that failed, or work that
 * happened outside the plan entirely.
 */
export function traceIsInteresting(trace: CausalTrace): boolean {
	return trace.steps.some((step) => !step.ok) || trace.unattributed.length > 0;
}
