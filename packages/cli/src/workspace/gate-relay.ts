/**
 * The half of the gate that was missing: asking a person, from the machine.
 *
 * Everything else existed. The policy says a call needs approval, the enforcement
 * handler knows how to wait for an answer, the protocol carries `gate.opened` and
 * `gate.resolved`, the room derives a gate from the event and holds it, the
 * workspace lists it under "waiting on you", and a person's answer comes back down
 * the socket. What nothing did was open one: `openGate` was declared in the
 * handler's dependencies and never provided, so every gated call was refused with
 * "this machine cannot reach the workspace to ask for it", which was true and was
 * true forever.
 *
 * The cost is easy to under-read. A persona whose posture is `on-request` does not
 * run slowly under that bug; it runs and can do nothing, and the transcript says so
 * in the agent's own words. The two-axis gate had one axis that could only refuse.
 *
 * ## The decision inside: what ties a hook call to a run
 *
 * A `GateRequest` names a call, not a job, and `gate.opened` is an event ON a job.
 * Something has to join them.
 *
 * It is the **directory**. The hook is spawned inside one and that is the only
 * thing it reliably knows, which is the same reasoning the enforcement endpoint
 * already uses to pick a socket. So the relay asks which run is in flight there,
 * and reports the gate on that run.
 *
 * That leaves a case worth naming rather than folding away: a call in a consented
 * directory with **no run in flight**, which is a person using their own agent in a
 * folder the daemon watches. There is no run page, no row, and nobody to ask. It is
 * refused, and it is refused under its own name, because sending that operator to
 * look for an approval that was never asked for is worse than saying so.
 *
 * ## What this deliberately does not do
 *
 * Emit `gate.resolved`. The room writes that when a person answers, and the record
 * holding one writer per fact is the reason its state and its history cannot
 * describe different pasts. A daemon that also wrote it would be a second author of
 * the same event.
 *
 * And it does not wait forever. The room owns expiry and will say so, but a socket
 * that dropped between the question and the answer would leave the hook hanging
 * until the host's own ceiling, which reads as a freeze and teaches people to turn
 * enforcement off. The backstop here sits past the gate's own deadline, so it is
 * the answer of last resort and never the one that normally decides.
 */

import { randomUUID } from "node:crypto";

import type { GateOutcome, GateRequest } from "./enforcement-service.js";

/** Emitting on a specific run. `JobReporter` satisfies this. */
export interface RunReporter {
	reportWire(body: { kind: string; [key: string]: unknown }): void;
}

/** Which run is in flight in a directory, if any. */
export type RunLookup = (cwd: string) => { jobId: string; reporter: RunReporter } | null;

/**
 * How long past a gate's own deadline the daemon waits before answering itself.
 *
 * Generous, because the room's answer is the one that should decide and a race
 * with it would produce a refusal for a call somebody approved. It only fires when
 * the answer is not coming at all.
 */
const BACKSTOP_MARGIN_MS = 15_000;

interface Pending {
	settle: (outcome: GateOutcome) => void;
	timer: NodeJS.Timeout;
	jobId: string;
}

export class GateRelay {
	private readonly pending = new Map<string, Pending>();

	constructor(
		private readonly deps: {
			runFor: RunLookup;
			/** Injected by tests. */
			newGateId?: () => string;
		},
	) {}

	/** Gates waiting on a person, for a status line. */
	get waitingCount(): number {
		return this.pending.size;
	}

	/**
	 * Asks, and waits.
	 *
	 * Resolves with what a person decided, `expired` when nobody did in time, or
	 * `unreachable` when there was no run here to ask on. Never rejects: a throw
	 * on this path would reach the hook as a failure with no verdict, and a hook
	 * that cannot say what happened is a hook that gets disabled.
	 */
	open(request: GateRequest & { cwd: string }): Promise<GateOutcome> {
		const run = this.deps.runFor(request.cwd);
		if (!run) return Promise.resolve("unreachable");

		const gateId = (this.deps.newGateId ?? randomUUID)();
		const expiresAt = new Date(Date.now() + request.timeout_seconds * 1000);

		return new Promise<GateOutcome>((resolve) => {
			const settle = (outcome: GateOutcome) => {
				const entry = this.pending.get(gateId);
				if (!entry) return;
				clearTimeout(entry.timer);
				this.pending.delete(gateId);
				resolve(outcome);
			};

			const timer = setTimeout(
				() => settle("expired"),
				request.timeout_seconds * 1000 + BACKSTOP_MARGIN_MS,
			);
			// Nothing should be held open by a gate nobody is going to answer.
			timer.unref?.();

			this.pending.set(gateId, { settle, timer, jobId: run.jobId });

			try {
				run.reporter.reportWire({
					kind: "gate.opened",
					gate_id: gateId,
					// The host's own id for this call, so the proposal, the gate and the
					// result are one identity across three processes.
					call_id: request.call_id,
					tool: request.tool,
					args_preview: request.args_text,
					reason: request.reason,
					// The class that actually fired. The room recorded a constant without
					// it, so every gate looked like the same kind of gate.
					action_class: request.action_class,
					required_approvals: request.required_approvals,
					route: request.route,
					expires_at: expiresAt.toISOString(),
				});
			} catch {
				// The question never left. Refusing now beats waiting out a deadline
				// for an answer to something nobody was asked.
				settle("unreachable");
			}
		});
	}

	/** A person answered. Returns whether anything was waiting for it. */
	resolve(gateId: string, outcome: GateOutcome): boolean {
		const entry = this.pending.get(gateId);
		if (!entry) return false;
		entry.settle(outcome);
		return true;
	}

	/**
	 * The run this gate belongs to is over, or the wire went down.
	 *
	 * Everything waiting is refused rather than left hanging, which is the same
	 * direction every other unanswered path here takes.
	 */
	abandon(jobId?: string): void {
		for (const [gateId, entry] of [...this.pending]) {
			if (jobId && entry.jobId !== jobId) continue;
			entry.settle("expired");
			this.pending.delete(gateId);
		}
	}
}
