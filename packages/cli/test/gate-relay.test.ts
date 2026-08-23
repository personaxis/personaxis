/**
 * Asking a person, from the machine.
 *
 * This is the half of the gate that did not exist. Everything else did: the policy
 * asks for approval, the handler waits for an answer, the protocol carries the
 * question and the reply, the room derives a gate from the event, the workspace
 * lists it, and a person's answer comes back down the socket. Nothing opened one.
 * `openGate` was declared in the handler's dependencies and never provided, so
 * every gated call was refused with "this machine cannot reach the workspace to ask
 * for it", which was true and stayed true.
 *
 * What the cost looked like from outside: a persona whose posture is `on-request`
 * did not run slowly, it ran and could do nothing, and said so itself in the
 * transcript. One of the two axes could only refuse.
 *
 * The tests below are about the joins, because the joins are where this can be
 * quietly wrong: which run a call belongs to, and every path that must answer
 * rather than hang.
 */

import { describe, expect, it, vi } from "vitest";

import { GateRelay, type RunReporter } from "../src/workspace/gate-relay.js";
import type { GateRequest } from "../src/workspace/enforcement-service.js";

const ask = (over: Partial<GateRequest> = {}): GateRequest & { cwd: string } => ({
	call_id: "toolu_1",
	tool: "Bash",
	args_text: "rm -rf build",
	action_class: "file_delete",
	required_approvals: 1,
	timeout_seconds: 600,
	route: { roles: ["owner"] },
	reason: "this persona's policy asks a person before anything in file_delete",
	cwd: "/work/repo",
	...over,
});

function run() {
	const emitted: Array<Record<string, unknown>> = [];
	const reporter: RunReporter = { reportWire: (body) => void emitted.push(body) };
	return { reporter, emitted };
}

describe("finding the run a call belongs to", () => {
	it("asks on the run in flight in that directory", async () => {
		const job = run();
		const relay = new GateRelay({
			runFor: () => ({ jobId: "job_1", reporter: job.reporter }),
			newGateId: () => "gate_1",
		});

		const pending = relay.open(ask());
		relay.resolve("gate_1", "approved");

		await expect(pending).resolves.toBe("approved");
		expect(job.emitted[0]).toMatchObject({ kind: "gate.opened", gate_id: "gate_1" });
	});

	it("carries the host's own id for the call, so three processes share one identity", async () => {
		// The proposal, the gate and the result correlate for free only because
		// this is the id the host minted, not one invented on the way out.
		const job = run();
		const relay = new GateRelay({
			runFor: () => ({ jobId: "job_1", reporter: job.reporter }),
			newGateId: () => "gate_1",
		});

		const pending = relay.open(ask({ call_id: "toolu_from_the_host" }));
		relay.resolve("gate_1", "denied");
		await pending;

		expect(job.emitted[0]).toMatchObject({ call_id: "toolu_from_the_host" });
	});

	it("carries what a person needs to decide: the tool, the arguments and the reason", async () => {
		const job = run();
		const relay = new GateRelay({
			runFor: () => ({ jobId: "job_1", reporter: job.reporter }),
			newGateId: () => "gate_1",
		});

		const pending = relay.open(ask());
		relay.resolve("gate_1", "approved");
		await pending;

		expect(job.emitted[0]).toMatchObject({
			tool: "Bash",
			args_preview: "rm -rf build",
			reason: expect.stringContaining("file_delete"),
			required_approvals: 1,
			route: { roles: ["owner"] },
		});
		expect(Date.parse(job.emitted[0].expires_at as string)).toBeGreaterThan(Date.now());
	});

	it("refuses under its own name when no run is in flight here", async () => {
		// A person using their own agent in a consented folder. There is no run
		// page, no row and nobody to ask, and sending them to look for an approval
		// that was never requested is worse than saying so.
		const relay = new GateRelay({ runFor: () => null });

		await expect(relay.open(ask())).resolves.toBe("unreachable");
	});

	it("does not ask when the question could not be sent", async () => {
		// Waiting out a deadline for an answer to something nobody was asked is
		// the slowest possible way to reach the same refusal.
		const relay = new GateRelay({
			runFor: () => ({
				jobId: "job_1",
				reporter: {
					reportWire: () => {
						throw new Error("socket gone");
					},
				},
			}),
		});

		await expect(relay.open(ask())).resolves.toBe("unreachable");
	});
});

describe("every way a gate ends", () => {
	const relayWith = (emitted = run()) => ({
		emitted,
		relay: new GateRelay({
			runFor: () => ({ jobId: "job_1", reporter: emitted.reporter }),
			newGateId: () => "gate_1",
		}),
	});

	it("passes a person's yes through as an allow", async () => {
		const { relay } = relayWith();
		const pending = relay.open(ask());

		relay.resolve("gate_1", "approved");

		await expect(pending).resolves.toBe("approved");
	});

	it("passes a person's no through", async () => {
		const { relay } = relayWith();
		const pending = relay.open(ask());

		relay.resolve("gate_1", "denied");

		await expect(pending).resolves.toBe("denied");
	});

	it("answers by itself when the answer never comes", async () => {
		// The room owns expiry and normally says so first. This is the backstop for
		// a socket that dropped between the question and the reply: without it the
		// hook hangs until the host's own ceiling, which reads as a freeze.
		vi.useFakeTimers();
		try {
			const { relay } = relayWith();
			const pending = relay.open(ask({ timeout_seconds: 60 }));

			await vi.advanceTimersByTimeAsync(60_000 + 15_000 + 10);

			await expect(pending).resolves.toBe("expired");
		} finally {
			vi.useRealTimers();
		}
	});

	it("waits past the gate's own deadline, so it never races the room's answer", async () => {
		// Answering first would refuse a call somebody approved.
		vi.useFakeTimers();
		try {
			const { relay } = relayWith();
			const settled = vi.fn();
			void relay.open(ask({ timeout_seconds: 60 })).then(settled);

			await vi.advanceTimersByTimeAsync(60_500);

			expect(settled).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("refuses what is still waiting when its run ends", async () => {
		const { relay } = relayWith();
		const pending = relay.open(ask());

		relay.abandon("job_1");

		await expect(pending).resolves.toBe("expired");
	});

	it("leaves another run's gates alone", async () => {
		const { relay } = relayWith();
		const pending = relay.open(ask());

		relay.abandon("some_other_job");

		expect(relay.waitingCount).toBe(1);
		relay.resolve("gate_1", "approved");
		await expect(pending).resolves.toBe("approved");
	});

	it("refuses everything when the wire goes down", async () => {
		const { relay } = relayWith();
		const pending = relay.open(ask());

		relay.abandon();

		await expect(pending).resolves.toBe("expired");
		expect(relay.waitingCount).toBe(0);
	});

	it("ignores an answer to a gate nobody is waiting on", async () => {
		// A late reply after a timeout, or one for another daemon's gate. Neither
		// is an error and neither must disturb anything still open.
		const { relay } = relayWith();

		expect(relay.resolve("gate_that_never_was", "approved")).toBe(false);
	});

	it("settles once, so a second answer changes nothing", async () => {
		const { relay } = relayWith();
		const pending = relay.open(ask());

		relay.resolve("gate_1", "approved");
		expect(relay.resolve("gate_1", "denied")).toBe(false);

		await expect(pending).resolves.toBe("approved");
	});
});
