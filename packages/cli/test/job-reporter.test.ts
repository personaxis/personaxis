// Correlating a tool call across its three events is this file's whole job, and
// getting it wrong means a gate freezing a different call than the one a person
// is looking at. So that is what most of these are about.

import type { LoopEvent } from "@personaxis/core";
import type { WireEvent } from "@personaxis/protocol/workspace";
import { describe, expect, it } from "vitest";

import { JobReporter, reportTo } from "../src/workspace/job-reporter.js";

const NOW = new Date("2026-08-02T12:00:00.000Z");

function makeReporter(overrides: Partial<ConstructorParameters<typeof JobReporter>[0]> = {}) {
	const emitted: WireEvent[] = [];
	const finished: string[] = [];
	const drops: { kind: string; reason: string }[] = [];

	const reporter = new JobReporter({
		jobId: "job_1",
		now: () => NOW,
		sink: {
			emit: (event) => emitted.push(event),
			finishJob: (jobId) => finished.push(jobId),
		},
		onDrop: (kind, reason) => drops.push({ kind, reason }),
		...overrides,
	});

	return { reporter, emitted, finished, drops };
}

const propose = { type: "tool-propose", tool: "Bash", args: { command: "ls" } } as LoopEvent;
const allow = { type: "tool-verdict", decision: "allow", reason: "allowlist" } as LoopEvent;
const result = { type: "tool-result", ok: true, output: "a b c" } as LoopEvent;

describe("correlating a tool call", () => {
	it("gives propose, verdict and result the same call id", () => {
		const { reporter, emitted } = makeReporter();
		reporter.report(propose);
		reporter.report(allow);
		reporter.report(result);

		const ids = emitted.map((event) => (event as { call_id?: string }).call_id);
		expect(new Set(ids).size).toBe(1);
		expect(ids[0]).toBeTruthy();
	});

	it("gives a second call a different id", () => {
		// Two calls sharing an id means a gate freezing the wrong one.
		const { reporter, emitted } = makeReporter();
		reporter.report(propose);
		reporter.report(result);
		reporter.report(propose);
		reporter.report(result);

		const ids = emitted.map((event) => (event as { call_id?: string }).call_id);
		expect(ids[0]).not.toBe(ids[2]);
	});

	it("does not lend the previous call's id to an event between calls", () => {
		// Clearing at the result rather than at the next proposal is what stops
		// a stray event from borrowing an id that already closed.
		const { reporter, emitted } = makeReporter();
		reporter.report(propose);
		reporter.report(result);
		reporter.report({ type: "agent-step", step: 2 } as LoopEvent);

		const stray = emitted.at(-1) as { call_id?: string };
		expect(stray.call_id).toBeUndefined();
	});
});

describe("the envelope", () => {
	it("stamps the job and the source", () => {
		const { reporter, emitted } = makeReporter();
		reporter.report(propose);
		expect(emitted[0]).toMatchObject({ job_id: "job_1", source: "daemon" });
	});

	it("leaves seq at zero, because the control plane assigns it", () => {
		// A producer numbering its own events would give two daemons on one job
		// two conflicting orders.
		const { reporter, emitted } = makeReporter();
		reporter.report(propose);
		expect(emitted[0].seq).toBe(0);
	});

	it("takes its timestamp from the injected clock", () => {
		const { reporter, emitted } = makeReporter();
		reporter.report(propose);
		expect(emitted[0].ts).toBe(NOW.toISOString());
	});

	it("can report a hosted run", () => {
		const { reporter, emitted } = makeReporter({ source: "hosted" });
		reporter.report(propose);
		expect(emitted[0].source).toBe("hosted");
	});
});

describe("events that do not reach the wire", () => {
	it("counts a deliberate drop and says why", () => {
		const { reporter, drops, emitted } = makeReporter();
		// An "ask" verdict is what opens a gate, and the gate carries routing
		// this event does not have, so the adapter drops it.
		reporter.report(propose);
		reporter.report({ type: "tool-verdict", decision: "ask", reason: "gated" } as LoopEvent);

		expect(emitted).toHaveLength(1);
		expect(reporter.dropped).toBe(1);
		expect(drops[0].reason).toBe("covered-elsewhere");
	});

	it("keeps going after a drop", () => {
		const { reporter, emitted } = makeReporter();
		reporter.report(propose);
		reporter.report({ type: "tool-verdict", decision: "ask", reason: "gated" } as LoopEvent);
		reporter.report(result);
		expect(emitted).toHaveLength(2);
	});
});

describe("never taking the run down with it", () => {
	it("does not throw when the sink throws", () => {
		// A job that dies because nobody could watch it is the worst trade
		// available here.
		const reporter = new JobReporter({
			jobId: "job_1",
			sink: {
				emit: () => {
					throw new Error("socket exploded");
				},
			},
		});

		expect(() => reporter.report(propose)).not.toThrow();
		expect(reporter.dropped).toBe(1);
	});

	it("does not throw on an event shape it has never seen", () => {
		const { reporter } = makeReporter();
		expect(() => reporter.report({ type: "quantum-collapse" } as unknown as LoopEvent)).not.toThrow();
	});
});

describe("ending", () => {
	it("releases the job when the session ends", () => {
		const { reporter, finished } = makeReporter();
		reporter.report({ type: "agent-error", message: "boom" } as LoopEvent);
		expect(finished).toEqual(["job_1"]);
	});

	it("releases it only once", () => {
		// A stop condition racing an error produces two endings, and releasing
		// the queue twice would drop what is still unacknowledged.
		const { reporter, finished } = makeReporter();
		reporter.report({ type: "agent-error", message: "boom" } as LoopEvent);
		reporter.report({ type: "error", message: "boom again" } as LoopEvent);
		reporter.finish();
		expect(finished).toEqual(["job_1"]);
	});
});

describe("subscribing", () => {
	it("reports what the source emits, and stops when unsubscribed", () => {
		const listeners: ((event: LoopEvent) => void)[] = [];
		const source = {
			on: (listener: (event: LoopEvent) => void) => {
				listeners.push(listener);
				return () => {
					listeners.splice(listeners.indexOf(listener), 1);
				};
			},
		};

		const { reporter, emitted } = makeReporter();
		const stop = reportTo(source, reporter);

		for (const listener of listeners) listener(propose);
		expect(emitted).toHaveLength(1);

		stop();
		for (const listener of listeners) listener(propose);
		expect(emitted).toHaveLength(1);
	});
});
