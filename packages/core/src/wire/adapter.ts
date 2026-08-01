/**
 * Translates the engine's events into the workspace wire vocabulary.
 *
 * The engine speaks about a running loop; the workspace speaks about a job a
 * team is watching. They are deliberately different vocabularies, and this is
 * the one place that knows both. Teaching the workspace to understand
 * LoopEvents directly would tie the browser to the engine's internals and make
 * every engine refactor a wire change.
 *
 * The mapping is a closed list. Every LoopEvent kind either maps to a wire
 * event or is explicitly dropped with a reason, and a test walks the engine's
 * union to prove none is missing. An event that fell through a default case
 * would vanish from the record, and the record is what the product sells.
 */

import type { LoopEvent } from "../events.js";

/** The subset of the envelope a producer fills. `seq` belongs to the JobRoom. */
export interface WireEmission {
	kind: string;
	[field: string]: unknown;
}

/** Why an engine event does not become a wire event. */
export type DropReason =
	/** Internal to how the engine thinks; the workspace shows outcomes. */
	| "engine-internal"
	/** Already carried by another wire event, so emitting it would duplicate. */
	| "covered-elsewhere"
	/** Belongs to the operator's terminal, not to a shared session. */
	| "local-only";

export type MappingResult =
	| { emit: WireEmission }
	| { drop: DropReason };

/** Truncates a preview, since the wire carries summaries and not payloads. */
const PREVIEW_LIMIT = 512;

export function preview(value: unknown): string {
	let text: string;
	if (typeof value === "string") {
		text = value;
	} else {
		try {
			text = JSON.stringify(value ?? null) ?? String(value);
		} catch {
			// Tool arguments come from a model and can be anything, including a
			// structure that does not serialise. Losing the preview is a small
			// cost; throwing here would drop the event, and a tool call missing
			// from the record is the one thing this pipeline must not do.
			text = "[unserialisable]";
		}
	}
	return text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT - 1)}…` : text;
}

/**
 * A stable id for a tool call across its propose, verdict and result events.
 *
 * The engine does not carry one: its events are consumed in order by a single
 * listener, so it never needed to. The workspace does, because a gate freezes
 * one specific call and several may be in flight. The caller supplies it.
 */
export interface MappingContext {
	/** Id for the tool call currently in flight, if any. */
	callId?: string;
}

/**
 * Maps one engine event. Returns what to emit, or why nothing is emitted.
 *
 * Exhaustive by construction: the switch covers every member of LoopEvent and
 * TypeScript fails the build if a new one appears without a case here.
 */
export function mapLoopEvent(event: LoopEvent, context: MappingContext = {}): MappingResult {
	const callId = context.callId ?? "";

	switch (event.type) {
		// ─── Tool calls: the events the whole product exists to show ─────────
		case "tool-propose":
			return {
				emit: {
					kind: "tool.call.requested",
					call_id: callId,
					tool: event.tool,
					args_preview: preview(event.args),
				},
			};

		case "tool-verdict":
			// "ask" is not a third wire event: it is what opens a gate, and the
			// gate is opened by the daemon with the routing and timeout the
			// policy declares, which this event does not carry.
			if (event.decision === "allow") {
				return { emit: { kind: "tool.call.allowed", call_id: callId, rule: event.reason } };
			}
			if (event.decision === "deny") {
				return {
					emit: {
						kind: "tool.call.blocked",
						call_id: callId,
						rule: event.reason,
						reason: event.reason,
					},
				};
			}
			return { drop: "covered-elsewhere" };

		case "tool-result":
			return {
				emit: {
					kind: "tool.call.completed",
					call_id: callId,
					ok: event.ok,
					output_preview: preview(event.output),
				},
			};

		// ─── The agent's turn ────────────────────────────────────────────────
		case "agent-step":
			return { emit: { kind: "agent.turn.started", turn: event.step } };

		case "agent-think":
			return { emit: { kind: "agent.thought.streamed", text: preview(event.text) } };

		case "agent-finish":
			return { emit: { kind: "agent.turn.ended", turn: event.steps, summary: event.summary } };

		// ─── State the workspace surfaces as behaviour ───────────────────────
		case "mutate": {
			// Only a clamp is worth a viewer's attention: it is the envelope
			// visibly holding. An unclamped mutation is routine.
			const result = event.result as { clamped?: boolean; path?: string; requested?: number; applied?: number };
			if (!result?.clamped) return { drop: "engine-internal" };
			return {
				emit: {
					kind: "envelope.clamped",
					field: result.path ?? "",
					requested: result.requested ?? 0,
					applied: result.applied ?? 0,
				},
			};
		}

		case "recompile": {
			// A behaviour change is a band crossing, not any numeric movement.
			// A recompile with no crossing changed nothing anyone can perceive.
			const crossings = event.crossings ?? [];
			if (crossings.length === 0) return { drop: "engine-internal" };
			const first = crossings[0];
			return {
				emit: {
					kind: "band.crossed",
					field: first.field,
					from_band: first.fromBand,
					to_band: first.toBand,
					prose: first.prose,
				},
			};
		}

		// ─── Ends of a session ───────────────────────────────────────────────
		case "agent-error":
			return { emit: { kind: "persona.session.ended", status: "failed", reason: event.message } };

		case "error":
			return { emit: { kind: "persona.session.ended", status: "failed", reason: event.message } };

		case "agent-stop-condition":
			return { emit: { kind: "persona.session.ended", status: "stopped", reason: event.reason } };

		// ─── Deliberately not on the wire ────────────────────────────────────
		//
		// Each of these is a decision, not an omission. The workspace shows what
		// a persona did and what held it back, and these are either how the
		// engine thinks, already implied by an event above, or meant for the
		// operator's own terminal.
		case "observe":
		case "appraise":
		case "govern":
		case "memory":
		case "memory-kind":
		case "memory-recall":
		case "evaluation":
		case "self-edit":
		case "anomaly":
		case "drift":
		case "abstain":
		case "tick-complete":
			return { drop: "engine-internal" };

		case "agent-budget":
		case "verify-start":
		case "verify-result":
		case "verify-complete":
		case "context-meter":
		case "context-compacted":
			return { drop: "engine-internal" };

		case "trace-exported":
			return { drop: "local-only" };

		default: {
			// Unreachable while the switch stays exhaustive. If a LoopEvent kind
			// is added without a case, this line stops compiling, which is the
			// point: an event silently missing from the record is the failure
			// this whole module is written to prevent.
			const unreachable: never = event;
			return { drop: `unmapped:${JSON.stringify(unreachable)}` as DropReason };
		}
	}
}

/** Every LoopEvent kind that becomes a wire event. */
export function mapsToWire(event: LoopEvent, context: MappingContext = {}): boolean {
	return "emit" in mapLoopEvent(event, context);
}
