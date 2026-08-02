/**
 * The bridge between a running persona and the workspace watching it.
 *
 * The engine emits LoopEvents about a loop. The workspace speaks about a job a
 * team is watching. `mapLoopEvent` translates between the two vocabularies and
 * `DaemonConnection` carries the result; this is the piece that sits between
 * them and holds the state neither of them has.
 *
 * That state is one thing: the call id. The engine does not carry one, because
 * its events are consumed in order by a single listener and it never needed to.
 * The workspace does, because a gate freezes one specific call and several may
 * be in flight. Correlating propose, verdict and result into one id is this
 * file's whole job, and getting it wrong means a gate freezing the wrong call.
 *
 * Everything else is deliberately absent. No buffering, because the connection
 * already does it and doing it twice would reorder on reconnect. No redaction,
 * because the adapter already did it and doing it twice means two places that
 * can drift.
 */

import { mapLoopEvent, type LoopEvent, type WireEmission } from "@personaxis/core";
import type { WireEvent, WireSource } from "@personaxis/protocol/workspace";

export interface ReporterSink {
	emit: (event: WireEvent) => void;
	finishJob?: (jobId: string) => void;
}

export interface JobReporterOptions {
	jobId: string;
	sink: ReporterSink;
	/** Injected so a test can assert on timestamps. */
	now?: () => Date;
	/** Where these events came from. `hosted` when the run is not on a laptop. */
	source?: WireSource;
	/** Told when an engine event does not reach the wire, and why. */
	onDrop?: (kind: string, reason: string) => void;
}

/** Events after which the job is over and the connection can release its queue. */
const TERMINAL_KINDS = new Set(["persona.session.ended"]);

export class JobReporter {
	private readonly options: Required<Omit<JobReporterOptions, "onDrop">> &
		Pick<JobReporterOptions, "onDrop">;

	/**
	 * The call currently in flight.
	 *
	 * One at a time, which matches how the engine runs: it proposes a call,
	 * waits for a verdict, and gets a result before proposing another. If that
	 * ever stops being true this becomes a map keyed by something the engine
	 * provides, and the tests here are what will notice.
	 */
	private currentCallId: string | null = null;
	private callCounter = 0;

	/** So a caller can say how much of a run never reached the workspace. */
	private droppedCount = 0;
	private finished = false;

	constructor(options: JobReporterOptions) {
		this.options = {
			now: () => new Date(),
			source: "daemon",
			...options,
		};
	}

	get dropped(): number {
		return this.droppedCount;
	}

	/**
	 * Reports one engine event.
	 *
	 * Never throws. A reporter that could throw would take down the run it is
	 * reporting on, and a job that dies because nobody could watch it is the
	 * worst possible trade.
	 */
	report(event: LoopEvent): void {
		try {
			this.reportUnsafe(event);
		} catch (error) {
			this.droppedCount++;
			this.options.onDrop?.(event.type, `reporter error: ${String(error)}`);
		}
	}

	private reportUnsafe(event: LoopEvent): void {
		// A new call starts at the proposal. Assigning the id here, before the
		// mapping, is what lets the verdict and the result reuse it.
		if (event.type === "tool-propose") {
			this.callCounter++;
			this.currentCallId = `call_${this.callCounter}`;
		}

		const result = mapLoopEvent(event, { callId: this.currentCallId ?? "" });

		if ("drop" in result) {
			this.droppedCount++;
			this.options.onDrop?.(event.type, result.drop);
			return;
		}

		// The call is over once its result is reported. Clearing here rather
		// than on the next proposal means a stray event between calls cannot
		// borrow the previous call's id.
		if (event.type === "tool-result") this.currentCallId = null;

		this.options.sink.emit(this.envelope(result.emit));

		if (TERMINAL_KINDS.has(result.emit.kind)) this.finish();
	}

	/**
	 * Wraps an emission in its envelope.
	 *
	 * `seq` is zero on purpose: the control plane assigns the authoritative
	 * sequence, and a producer that numbered its own events would give two
	 * daemons on the same job two conflicting orders.
	 */
	private envelope(emission: WireEmission): WireEvent {
		return {
			job_id: this.options.jobId,
			seq: 0,
			ts: this.options.now().toISOString(),
			source: this.options.source,
			...emission,
		} as WireEvent;
	}

	/**
	 * Marks the job over.
	 *
	 * Idempotent: a session that ends twice, which a stop condition racing an
	 * error can produce, must not release the queue twice.
	 */
	finish(): void {
		if (this.finished) return;
		this.finished = true;
		this.options.sink.finishJob?.(this.options.jobId);
	}
}

/**
 * Subscribes a reporter to an event source.
 *
 * Returns the unsubscribe, so a caller that starts a run can stop reporting on
 * it without reaching into the reporter.
 */
export function reportTo(
	source: { on: (listener: (event: LoopEvent) => void) => () => void },
	reporter: JobReporter,
): () => void {
	return source.on((event) => reporter.report(event));
}
