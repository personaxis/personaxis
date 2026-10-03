/**
 * E126: the self-regulation a persona declares, applied at the gate when its own record says it has been failing.
 *
 * ## Why this exists
 *
 * Every persona Genesis writes declares `metacognition.thresholds` (`abstain_if_confidence_below`,
 * `escalate_if_policy_risk_above`) and the decisions its self-regulation may take (`escalate_to_human`,
 * `reduce_autonomy`), and until this no part of the runtime read any of it. The purpose of the persona's
 * evolution is calibration: a persona that has been failing should not keep
 * the same autonomy as one that has been delivering.
 *
 * ## Why only the gate, and nothing the model reads
 *
 * Measured on 2026-09-23 (plan, section 13.10). A first version told the model why it had been tightened, and
 * that one sentence took `fix-crash` from 6/6 to 0/6: a small model told it has been failing stops working.
 * The same version tightened the session's policy, which is the one printed in the scope the model reads, and
 * not the compiled gate, which is the one that decides; so it leaked and did not act. And a band written into
 * the identity never changed how much a persona checks, with either model. The only lever that has moved
 * behaviour in the whole programme is the tool layer. So this tightens the approval posture of the policy the
 * gate compiles, and nothing else: not the scope line, not the message of the moment, not the hand-back. The
 * model sees the same prompt either way; a person is asked before its writes run, and the reason is written
 * where that person reads it, in the gate's own verdict.
 *
 * ## Why the numbers are read against the record and not against the model
 *
 * A model's own confidence is a poor instrument. What the runtime established itself is reliable, and E117
 * already writes it: whether the persona's deliveries passed their checks, and how many of its calls the gate
 * refused. So "confidence" is the share of its recent checked deliveries that passed, and "risk" the share of
 * its recent calls the gate denied. Ambiguity has no reliable signal and is not invented.
 *
 * ## What it may do
 *
 * Only tighten, and only what the persona enabled: a decision missing from its `enabled` list never fires.
 * Nothing here loosens a posture; the window moving past the failures is what relaxes it.
 */

import { readRecord, recordPathFor } from "../record/store.js";
import type { RecordEntry } from "../record/entry.js";
import type { ApprovalPosture } from "../enforcement/policy-compile.js";
import { stricterApproval } from "../sandbox.js";

/** How many checked deliveries, and how many calls, the window looks back over. */
const DELIVERIES = 5;
const CALLS = 20;
/** Below these there is not enough evidence to call it a pattern: one failure is not a trend. */
const MIN_DELIVERIES = 2;
const MIN_CALLS = 5;

/** What the record says about how the persona has been doing lately. */
interface Conduct {
	/** Share of recent checked deliveries whose every check passed. Absent without enough of them. */
	readonly confidence?: number;
	readonly delivered: { readonly passed: number; readonly checked: number };
	/** Share of recent calls the gate denied. Absent without enough calls. */
	readonly risk?: number;
	readonly calls: { readonly denied: number; readonly seen: number };
}

/** The posture the gate must at least hold this turn, and why, in words for the person who approves. */
export interface Regulation {
	readonly approval?: ApprovalPosture;
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

	let approval: ApprovalPosture | undefined;
	const because: string[] = [];
	const tighten = (to: ApprovalPosture): void => {
		approval = approval === undefined ? to : stricterApproval(approval, to);
	};

	if (
		conduct.confidence !== undefined &&
		abstainBelow !== undefined &&
		conduct.confidence < abstainBelow &&
		enabled(decisions, "interaction_decision", "escalate_to_human")
	) {
		tighten("untrusted");
		because.push(
			`${conduct.delivered.passed} of its last ${conduct.delivered.checked} checked deliveries passed, below the ${abstainBelow} it declares`,
		);
	}
	if (
		conduct.risk !== undefined &&
		escalateAbove !== undefined &&
		conduct.risk > escalateAbove &&
		enabled(decisions, "governance_decision", "reduce_autonomy")
	) {
		tighten("on-request");
		because.push(
			`the gate refused ${conduct.calls.denied} of its last ${conduct.calls.seen} calls, above the ${escalateAbove} it declares`,
		);
	}
	return { ...(approval === undefined ? {} : { approval }), because };
}

/** The regulation for a persona now, from its own record. Never throws: without a record there is nothing to regulate. */
export function regulationFor(personaPath: string, frontmatter: Dict): Regulation {
	try {
		return regulate(frontmatter, conductFrom(readRecord(recordPathFor(personaPath))));
	} catch {
		return { because: [] };
	}
}
