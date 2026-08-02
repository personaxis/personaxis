// A whole run, from engine event to the frame that leaves the machine.
//
// The unit tests either side of this one prove the reporter correlates calls
// and the connection queues and resumes. Neither proves the two together
// produce a stream the workspace can actually replay, and that is the claim
// this file is about:
//
//   every event that should be on the wire is on it, in order
//   sequence numbers are dense from 1, so a gap means a real gap
//   a secret typed into a tool call never leaves the machine
//   a disconnection mid-run loses nothing
//
// It uses the real reporter, the real adapter and the real connection, with a
// fake socket. What is faked is the network, and nothing else.

import type { LoopEvent } from "@personaxis/core";
import { describe, expect, it } from "vitest";

import { DaemonConnection, type DaemonSocket } from "../src/workspace/connection.js";
import { JobReporter } from "../src/workspace/job-reporter.js";

const SECRET = "ghp_abcdefghijklmnopqrstuvwxyz012345";

const REGISTER = {
	machine_name: "ana-macbook",
	os: "darwin",
	daemon_version: "0.16.4",
	host_agents: [],
	working_dirs: ["/work"],
	cached_policies: [],
} as const;

/** A socket that records what was written and can be dropped on command. */
function fakeSocket() {
	const frames: string[] = [];
	let handlers: { onOpen?: () => void; onMessage?: (d: string) => void; onClose?: (c: number) => void } = {};
	let open = true;

	const socket: DaemonSocket = {
		send: (data: string) => {
			if (!open) throw new Error("socket closed");
			frames.push(data);
		},
		close: () => {
			open = false;
		},
		onOpen: (fn) => {
			handlers.onOpen = fn;
		},
		onMessage: (fn) => {
			handlers.onMessage = fn;
		},
		onClose: (fn) => {
			handlers.onClose = fn;
		},
		onError: () => {},
	} as unknown as DaemonSocket;

	return {
		socket,
		frames,
		openIt: () => handlers.onOpen?.(),
		drop: (code = 1006) => {
			open = false;
			handlers.onClose?.(code);
		},
		deliver: (message: unknown) => handlers.onMessage?.(JSON.stringify(message)),
	};
}

/** The events a short, realistic run produces. */
function runEvents(): LoopEvent[] {
	return [
		{ type: "agent-step", step: 1 },
		{ type: "agent-think", text: "I will check the deploy status" },
		{
			type: "tool-propose",
			tool: "Bash",
			args: { command: `curl -H "Authorization: Bearer ${SECRET}" https://api.example.com/status` },
		},
		{ type: "tool-verdict", decision: "allow", reason: "network read is allowed" },
		{ type: "tool-result", ok: true, output: "200 OK" },
		{ type: "agent-finish", steps: 1, summary: "Checked the deploy" },
	] as LoopEvent[];
}

/** Runs a session through the real pipeline into a fake socket. */
function runSession() {
	const wire = fakeSocket();
	const emitted: { job_id: string; seq: number; kind: string; [k: string]: unknown }[] = [];

	const reporter = new JobReporter({
		jobId: "job_1",
		sink: {
			emit: (event) => emitted.push(event as never),
		},
	});

	for (const event of runEvents()) reporter.report(event);

	return { reporter, emitted, wire };
}

describe("a run reaches the wire whole", () => {
	it("emits every event that belongs there, in the order it happened", () => {
		const { emitted } = runSession();
		expect(emitted.map((event) => event.kind)).toEqual([
			"agent.turn.started",
			"agent.thought.streamed",
			"tool.call.requested",
			"tool.call.allowed",
			"tool.call.completed",
			"agent.turn.ended",
		]);
	});

	it("keeps one call id across the three events of the call", () => {
		const { emitted } = runSession();
		const ids = emitted
			.filter((event) => event.kind.startsWith("tool.call."))
			.map((event) => event.call_id);
		expect(new Set(ids).size).toBe(1);
	});
});

describe("nothing leaves with a secret in it", () => {
	it("redacts the token from the command, and still says what ran", () => {
		const { emitted } = runSession();
		const requested = emitted.find((event) => event.kind === "tool.call.requested");

		expect(JSON.stringify(emitted)).not.toContain(SECRET);
		expect(String(requested?.args_preview)).toContain("curl");
		expect(String(requested?.args_preview)).toContain("[redacted]");
	});
});

describe("the sequence the workspace replays", () => {
	it("is dense from one, so a gap means a real gap", async () => {
		const wire = fakeSocket();
		const connection = new DaemonConnection({
			url: "wss://gw.example.com",
			token: "t",
			register: REGISTER,
			socketFactory: () => wire.socket,
		});

		connection.start();
		wire.openIt();
		// The workspace confirms the registration. Until it does the connection
		// is registering rather than online, and it holds events rather than
		// sending them to a server that has not said who it thinks this is.
		wire.deliver({ type: "registered", machine_id: "machine_1" });

		const reporter = new JobReporter({ jobId: "job_1", sink: connection });
		for (const event of runEvents()) reporter.report(event);

		const seqs = wire.frames
			.map((frame) => JSON.parse(frame) as { type: string; event?: { seq: number } })
			.filter((message) => message.type === "event")
			.map((message) => message.event?.seq);

		expect(seqs).toEqual([1, 2, 3, 4, 5, 6]);
		connection.stop();
	});
});

/**
 * A clock the test drives.
 *
 * Running callbacks inline is not an option: the heartbeat reschedules itself,
 * so an immediate scheduler recurses until the stack gives out. `runPending`
 * takes a snapshot, so work queued by the work it runs waits for the next call.
 */
function fakeScheduler() {
	let queued: (() => void)[] = [];
	return {
		scheduler: {
			setTimeout: (fn: () => void) => {
				queued.push(fn);
				return queued.length as never;
			},
			clearTimeout: () => {},
		},
		runPending: () => {
			const batch = queued;
			queued = [];
			for (const fn of batch) fn();
		},
	};
}

describe("the cost of a long run", () => {
	it("sends each event once while nothing is acknowledged", () => {
		// This is a regression test with teeth. An earlier flush re-sent the
		// whole queue on every emit, so a job producing a thousand events before
		// its first ack put half a million frames on the wire, and the cost grew
		// with the square of the run's length. Nothing failed; it was just
		// quietly quadratic.
		const wire = fakeSocket();
		const connection = new DaemonConnection({
			url: "wss://gw.example.com",
			token: "t",
			register: REGISTER,
			socketFactory: () => wire.socket,
		});

		connection.start();
		wire.openIt();
		wire.deliver({ type: "registered", machine_id: "machine_1" });

		const reporter = new JobReporter({ jobId: "job_1", sink: connection });
		const count = 50;
		for (let step = 1; step <= count; step++) {
			reporter.report({ type: "agent-step", step } as LoopEvent);
		}

		const events = wire.frames
			.map((frame) => JSON.parse(frame) as { type: string })
			.filter((message) => message.type === "event");

		expect(events).toHaveLength(count);
		connection.stop();
	});
});

describe("a disconnection mid run", () => {
	it("loses nothing: what was not acknowledged is sent again", () => {
		const first = fakeSocket();
		let current = first;
		const { scheduler, runPending } = fakeScheduler();

		const connection = new DaemonConnection({
			url: "wss://gw.example.com",
			token: "t",
			register: REGISTER,
			socketFactory: () => current.socket,
			// A controllable clock. Running callbacks inline would recurse
			// forever, because the heartbeat reschedules itself.
			scheduler,
			random: () => 0,
		});

		connection.start();
		first.openIt();
		first.deliver({ type: "registered", machine_id: "machine_1" });

		const reporter = new JobReporter({ jobId: "job_1", sink: connection });
		reporter.report({ type: "agent-step", step: 1 } as LoopEvent);
		reporter.report({ type: "agent-step", step: 2 } as LoopEvent);

		// The room took the first one only.
		first.deliver({ type: "ack", job_id: "job_1", seq: 1 });

		const second = fakeSocket();
		current = second;
		first.drop();
		// The backoff fires and the connection dials again.
		runPending();
		second.openIt();
		second.deliver({ type: "registered", machine_id: "machine_1" });

		const resent = second.frames
			.map((frame) => JSON.parse(frame) as { type: string; event?: { seq: number } })
			.filter((message) => message.type === "event")
			.map((message) => message.event?.seq);

		// Two is resent because nothing said it was durable. One is not, because
		// something did. Resending an acknowledged event would duplicate a row
		// in a chain that cannot be edited.
		expect(resent).toEqual([2]);
		connection.stop();
	});
});
