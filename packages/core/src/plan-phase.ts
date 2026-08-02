/**
 * J.4c: the PLAN phase, and what happens to a plan that does not survive its own gates.
 *
 * `assessPlan` already answers "would these steps be allowed", purely and testably. Nothing
 * called it. This is the half around it: reading the plan a model produced, and deciding
 * what the run does with the verdict.
 *
 * Both halves are where it goes wrong quietly.
 *
 * READING. A model asked for JSON returns JSON most of the time, and the rest of the time
 * returns JSON wrapped in prose, or a fence, or an object where an array was asked for. A
 * parser that throws turns a recoverable formatting slip into a dead run; one that accepts
 * anything lets a malformed plan through as an empty one, which assesses clean and tells
 * the operator their agent planned nothing dangerous.
 *
 * DECIDING. A blocked plan must come back to the model as something it can act on. "Plan
 * rejected" produces a second plan that differs at random. Naming the step, the tool and
 * the rule produces one that avoids it, which is the entire point of thinking before acting.
 */

import { assessPlan, type PlanAssessment, type PlanStep } from "./planner.js";
import type { ToolSpec } from "./tools/registry.js";
import type { Policy } from "./sandbox.js";

export type PlanParse =
	| { ok: true; steps: PlanStep[] }
	| { ok: false; error: string };

/**
 * Read a plan out of whatever the model actually said.
 *
 * Tolerant about packaging (a fence, prose around it, an object wrapping the array),
 * strict about content: a step needs a tool name that is a string, and args that are an
 * object. Tolerating THAT would be tolerating a plan whose steps mean nothing, which is
 * exactly the plan that assesses clean.
 */
export function parsePlan(raw: string): PlanParse {
	const text = raw.trim();
	if (!text) return { ok: false, error: "the plan was empty" };

	const candidates = [text, stripFence(text), extractArray(text), extractObject(text)].filter(
		(c): c is string => Boolean(c),
	);

	for (const candidate of candidates) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(candidate);
		} catch {
			continue;
		}

		// `{ steps: [...] }` and a bare array are both common, and rejecting either would
		// fail a plan over its packaging rather than its content.
		const array = Array.isArray(parsed)
			? parsed
			: typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { steps?: unknown }).steps)
				? (parsed as { steps: unknown[] }).steps
				: null;

		if (!array) continue;
		return readSteps(array);
	}

	return {
		ok: false,
		error: "the plan was not JSON. Reply with an array of steps: [{\"tool\": \"...\", \"args\": {...}}]",
	};
}

function readSteps(array: readonly unknown[]): PlanParse {
	// An empty array is a real answer ("nothing to do"), not a parse failure, and it must
	// not be confused with one: they lead to opposite next moves.
	const steps: PlanStep[] = [];

	for (const [index, entry] of array.entries()) {
		if (typeof entry !== "object" || entry === null) {
			return { ok: false, error: `step ${index + 1} is not an object` };
		}
		const record = entry as Record<string, unknown>;
		if (typeof record.tool !== "string" || !record.tool.trim()) {
			return { ok: false, error: `step ${index + 1} has no tool name` };
		}
		if (record.args !== undefined && (typeof record.args !== "object" || record.args === null || Array.isArray(record.args))) {
			return { ok: false, error: `step ${index + 1}'s args must be an object` };
		}

		steps.push({
			tool: record.tool.trim(),
			args: (record.args as Record<string, unknown>) ?? {},
			...(typeof record.note === "string" ? { note: record.note } : {}),
		});
	}

	return { ok: true, steps };
}

function stripFence(text: string): string | null {
	const match = text.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n```$/);
	return match ? match[1].trim() : null;
}

/** The outermost bracketed span, for a model that wrote a sentence around its JSON. */
function extractArray(text: string): string | null {
	const start = text.indexOf("[");
	const end = text.lastIndexOf("]");
	return start !== -1 && end > start ? text.slice(start, end + 1) : null;
}

function extractObject(text: string): string | null {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	return start !== -1 && end > start ? text.slice(start, end + 1) : null;
}

export type PlanOutcome =
	/** Run it. `anchor` goes into the conversation as system speech. */
	| { kind: "proceed"; steps: PlanStep[]; assessment: PlanAssessment; anchor: string }
	/** Do not run it. `feedback` goes back to the model so the next plan differs on purpose. */
	| { kind: "rejected"; assessment: PlanAssessment; feedback: string }
	/** Could not read it. Same idea, different cause. */
	| { kind: "unreadable"; feedback: string };

/**
 * Turn a model's plan into a decision.
 *
 * A plan with steps needing consent is NOT rejected: `ask` means a person decides at the
 * moment the step runs, and refusing it up front would make every plan touching anything
 * sensitive unrunnable. What is refused is a plan containing a step that can never run.
 */
export function decidePlan(raw: string, tools: readonly ToolSpec[], policy: Policy): PlanOutcome {
	const parsed = parsePlan(raw);
	if (!parsed.ok) {
		return {
			kind: "unreadable",
			feedback: `Your plan could not be read: ${parsed.error}. Reply with only a JSON array of steps.`,
		};
	}

	const assessment = assessPlan(parsed.steps, [...tools], policy);

	if (!assessment.ok) {
		return { kind: "rejected", assessment, feedback: describeBlocked(assessment) };
	}

	return { kind: "proceed", steps: parsed.steps, assessment, anchor: describeAnchor(parsed.steps, assessment) };
}

/**
 * Why the plan was refused, in terms the model can plan around.
 *
 * Names the step number, the tool and the rule. "Plan rejected" produces a second plan that
 * differs at random; this produces one that avoids the thing that was refused.
 */
export function describeBlocked(assessment: PlanAssessment): string {
	const lines = assessment.blocked.map(
		(risk) => `step ${risk.index + 1} (${risk.tool}): ${risk.reason}`,
	);

	return [
		`This plan cannot run as written. ${assessment.blocked.length} step(s) would be refused:`,
		...lines,
		"",
		"Replan without those steps. If the task cannot be done within these limits, say so instead of working around them.",
	].join("\n");
}

/**
 * The plan, anchored as system speech for the rest of the run.
 *
 * System rather than assistant, because it is a decision the run has already made and not
 * something the model said and may talk itself out of. Steps needing consent are marked, so
 * the model is not surprised when one stops to ask.
 */
export function describeAnchor(steps: readonly PlanStep[], assessment: PlanAssessment): string {
	const needsConsent = new Set(assessment.needsConsent.map((r) => r.index));
	const lines = steps.map((step, index) => {
		const note = step.note ? ` — ${step.note}` : "";
		return `${index + 1}. ${step.tool}${note}${needsConsent.has(index) ? " (will ask for approval)" : ""}`;
	});

	return [
		"This run is executing the following plan, which has been checked against the persona's limits:",
		...lines,
		"",
		"Deviating from it is allowed when what you learn requires it; say why before you do.",
	].join("\n");
}
