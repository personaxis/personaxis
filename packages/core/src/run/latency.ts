/**
 * E17: where a turn's wall time actually goes.
 *
 * The loop already reported `wallSeconds`, and a total is the one number that cannot
 * answer the question anybody asks about latency, which is WHICH PART GOT SLOWER. The
 * three parts move independently and for unrelated reasons: the model is the network
 * and the provider, the gate is our own policy evaluation, and the tool is whatever
 * the machine was asked to do. A turn that went from 4s to 9s because a provider
 * queued and a turn that went from 4s to 9s because the gate started recompiling a
 * policy per call are the same total and opposite problems.
 *
 * What is NOT measured stays visible. `unattributed` is the total minus the three
 * parts, reported rather than divided among them: the moment an unmeasured stretch is
 * silently attributed to a part that was measured, the breakdown starts lying in the
 * direction of whatever is already instrumented.
 */

/** The parts of a turn that move for different reasons, so they are timed apart. */
export type LatencyPart = "model" | "gate" | "tool";

export interface LatencyReport {
	readonly modelMs: number;
	readonly gateMs: number;
	readonly toolMs: number;
	readonly totalMs: number;
	/**
	 * Wall time inside the run that none of the three parts claimed.
	 *
	 * Never negative: the parts are measured with the same clock as the total, but
	 * they nest (a tool call happens inside a step, and a step inside the run), so a
	 * rounding or a future overlap must not turn into a negative number that reads
	 * like a measurement.
	 */
	readonly unattributedMs: number;
	/** How many timed spans each part saw, so an average is possible. */
	readonly calls: Readonly<Record<LatencyPart, number>>;
	/** Set when a per-turn budget was declared and a turn went past it. */
	readonly overBudget?: { turnMs: number; worstTurnMs: number };
}

/**
 * Accumulates the three parts across a run.
 *
 * Deliberately not a decorator or a proxy over the loop: the three call sites are
 * named in agent.ts by hand, because a timer that wraps everything measures the
 * wrapper too, and this exists to be believed.
 */
export class LatencyMeter {
	private readonly totals: Record<LatencyPart, number> = { model: 0, gate: 0, tool: 0 };
	private readonly counts: Record<LatencyPart, number> = { model: 0, gate: 0, tool: 0 };
	private turnStart = 0;
	private worstTurn = 0;

	constructor(
		private readonly startedAt: number = Date.now(),
		/** A declared per-turn ceiling. Reported when exceeded, never enforced: see below. */
		private readonly turnBudgetMs?: number,
	) {}

	/** Time an async span. The result is passed through untouched. */
	async time<T>(part: LatencyPart, fn: () => Promise<T>): Promise<T> {
		const at = Date.now();
		try {
			return await fn();
		} finally {
			this.totals[part] += Date.now() - at;
			this.counts[part] += 1;
		}
	}

	/** Time a synchronous span, for the gate, which does not await anything. */
	sync<T>(part: LatencyPart, fn: () => T): T {
		const at = Date.now();
		try {
			return fn();
		} finally {
			this.totals[part] += Date.now() - at;
			this.counts[part] += 1;
		}
	}

	/**
	 * Mark the start of a turn, so the WORST single turn is known and not just the mean.
	 * A mean hides the one turn that made somebody complain.
	 *
	 * Starting a turn closes the previous one, and so does reporting. The alternative
	 * was a matching call at the end of the loop body, which the loop does not reliably
	 * reach: it returns from a dozen places, and a turn timer that only stops on the
	 * happy path would quietly report its longest turns as its shortest.
	 */
	turnBegan(): void {
		this.turnEnded();
		this.turnStart = Date.now();
	}

	private turnEnded(): void {
		if (this.turnStart === 0) return;
		this.worstTurn = Math.max(this.worstTurn, Date.now() - this.turnStart);
		this.turnStart = 0;
	}

	report(): LatencyReport {
		this.turnEnded();
		const totalMs = Date.now() - this.startedAt;
		const attributed = this.totals.model + this.totals.gate + this.totals.tool;
		const over =
			this.turnBudgetMs !== undefined && this.worstTurn > this.turnBudgetMs
				? { turnMs: this.turnBudgetMs, worstTurnMs: this.worstTurn }
				: undefined;
		return {
			modelMs: this.totals.model,
			gateMs: this.totals.gate,
			toolMs: this.totals.tool,
			totalMs,
			unattributedMs: Math.max(0, totalMs - attributed),
			calls: { ...this.counts },
			...(over ? { overBudget: over } : {}),
		};
	}
}
