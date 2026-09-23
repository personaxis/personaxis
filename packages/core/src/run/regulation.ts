/**
 * E126: the metacognition and self-regulation a persona declares, read against what it actually did.
 *
 * ## Why this exists
 *
 * Measured on 2026-09-23. Every persona Genesis writes declares `metacognition.thresholds`
 * (`abstain_if_confidence_below`, `escalate_if_policy_risk_above`, ...) and the decisions its
 * self-regulation may take (`request_more_evidence`, `escalate_to_human`, `reduce_autonomy`), and no
 * part of the runtime read any of it. The spec is explicit about what these layers are for:
 * metacognition is calibration, confidence against correctness, and it feeds the decisions of layer 9.
 * That is the piece that turns "it failed" into "it now checks more and asks first", which is the
 * purpose David chose for the persona's evolution (plan, section 13.8).
 *
 * ## Why the numbers are read against the record and not against the model
 *
 * A model's own confidence is a poor instrument: alignment training degrades calibration, and a
 * declared 90 % is closer to 75 % in production. What the runtime has that is reliable is what it
 * established itself, which E117 already feeds to the living loop: whether the persona's deliveries
 * passed their checks, and how many of its calls the gate refused. So "confidence" here is the share
 * of its recent checked deliveries that passed, and "risk" the share of its recent calls the gate
 * denied. Ambiguity has no reliable signal, so it is not invented: that stays with the model and
 * `ask_person` (E84).
 *
 * ## What it may do
 *
 * Only tighten, and only what the persona enabled. A decision missing from its `enabled` list never
 * fires: the persona declares what it may do to itself. Nothing here loosens a posture; the window
 * moving past the failures is what relaxes it.
 */

import { readRecord, recordPathFor } from "../record/store.js";
import type { RecordEntry } from "../record/entry.js";
import { stricterApproval, type ApprovalMode } from "../sandbox.js";

/** How many checked deliveries, and how many calls, the window looks back over. */
const DELIVERIES = 5;
const CALLS = 20;
/** Below these there is not enough evidence to call it a pattern: one failure is not a trend. */
const MIN_DELIVERIES = 2;
const MIN_CALLS = 5;

/** What the record says about how the persona has been doing lately. */
export interface Conduct {
	/** Share of recent checked deliveries whose every check passed. Absent without enough of them. */
	readonly confidence?: number;
	readonly delivered: { readonly passed: number; readonly checked: number };
	/** Share of recent calls the gate denied. Absent without enough calls. */
	readonly risk?: number;
	readonly calls: { readonly denied: number; readonly seen: number };
}

/** What to tighten this turn, and the reason for each, in words the persona and a person can read. */
export interface Regulation {
	/** A stricter approval posture, when one is warranted. */
	readonly approval?: ApprovalMode;
	/** How many times a broken delivery is handed back before the turn may close. The default is one. */
	readonly handBacks: number;
	readonly because: readonly string[];
}

function conductFrom(entries: readonly RecordEntry[]): Conduct {
	const checked = entries
		.map((entry) => entry.body)
		.filter((body): body is Extract<RecordEntry["body"], { type: "verification" }> => body.type === "verification" && body.checks.length > 0)
		.slice(-DELIVERIES);
	const passed = checked.filter((body) => body.checks.every((check) => check.passed)).length;
	const calls = entries
		.map((entry) => entry.body)
		.filter((body): body is Extract<RecordEntry["body"], { type: "call" }> => body.type === "call")
		.slice(-CALLS);
	const denied = calls.filter((call) => call.verdict === "denied").length;
	return {
		...(checked.length >= MIN_DELIVERIES ? { confidence: passed / checked.length } : {}),
		delivered: { passed, checked: checked.length },
		...(calls.length >= MIN_CALLS ? { risk: denied / calls.length } : {}),
		calls: { denied, seen: calls.length },
	};
}

type Dict = Record<string, unknown>;
const asDict = (value: unknown): Dict => (value && typeof value === "object" && !Array.isArray(value) ? (value as Dict) : {});
const threshold = (value: unknown): number | undefined => (typeof value === "number" && value >= 0 && value <= 1 ? value : undefined);
const enabled = (decisions: Dict, group: string, decision: string): boolean => {
	const list = asDict(decisions[group]).enabled;
	return Array.isArray(list) && list.includes(decision);
};

function regulate(frontmatter: Dict, conduct: Conduct): Regulation {
	const thresholds = asDict(asDict(frontmatter.metacognition).thresholds);
	const decisions = asDict(asDict(frontmatter.self_regulation).decisions);
	const abstainBelow = threshold(thresholds.abstain_if_confidence_below);
	const escalateAbove = threshold(thresholds.escalate_if_policy_risk_above);

	let approval: ApprovalMode | undefined;
	let handBacks = 1;
	const because: string[] = [];
	const tighten = (to: ApprovalMode): void => {
		approval = approval === undefined ? to : stricterApproval(approval, to);
	};

	if (conduct.confidence !== undefined && abstainBelow !== undefined && conduct.confidence < abstainBelow) {
		const record = `${conduct.delivered.passed} of your last ${conduct.delivered.checked} checked deliveries passed, below the ${abstainBelow} you declared`;
		if (enabled(decisions, "cognition_decision", "request_more_evidence")) {
			handBacks = 2;
			because.push(`${record}, so a delivery that fails its checks comes back to you twice before you may close`);
		}
		if (enabled(decisions, "interaction_decision", "escalate_to_human")) {
			tighten("untrusted");
			because.push(`${record}, so a person confirms any risky step before it runs`);
		}
	}
	if (conduct.risk !== undefined && escalateAbove !== undefined && conduct.risk > escalateAbove) {
		if (enabled(decisions, "governance_decision", "reduce_autonomy")) {
			tighten("on-request");
			because.push(
				`the gate refused ${conduct.calls.denied} of your last ${conduct.calls.seen} calls, above the ${escalateAbove} you declared, so you ask before writing`,
			);
		}
	}
	return { ...(approval === undefined ? {} : { approval }), handBacks, because };
}

/** The regulation for a persona now, from its own record. Never throws: without a record there is nothing to regulate. */
export function regulationFor(personaPath: string, frontmatter: Dict): Regulation {
	try {
		return regulate(frontmatter, conductFrom(readRecord(recordPathFor(personaPath))));
	} catch {
		return { handBacks: 1, because: [] };
	}
}
