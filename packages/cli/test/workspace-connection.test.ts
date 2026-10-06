/**
 * The daemon's socket, exercised without a network.
 *
 * The promise these tests hold to account is the one the product is sold on: a
 * dropped connection pauses reporting and nothing else. So the interesting
 * cases are all about the gap. Events produced offline must arrive, in order,
 * exactly once the server has acknowledged them; a machine told it was revoked
 * must stop and forget; and a daemon the server refuses on version grounds must
 * not hammer it forever.
 */

import { describe, expect, it } from "vitest";

import {
	BACKOFF_MAX_MS,
	DaemonConnection,
	HEARTBEAT_MS,
	MAX_QUEUED_PER_JOB,
	type DaemonSocket,
	type Scheduler,
} from "../src/workspace/connection.js";
import { consentedDirs, isWithinScope } from "../src/workspace/machine.js";
import type { WireEvent } from "@personaxis/protocol/workspace";

/** A socket that records what was sent and lets a test drive both ends. */
class FakeSocket implements DaemonSocket {
	sent: string[] = [];
	closed: { code?: number; reason?: string } | null = null;
	private open: (() => void) | null = null;
	private message: ((data: string) => void) | null = null;
	private close_: ((code: number, reason: string) => void) | null = null;

	send(data: string): void {
		this.sent.push(data);
	}
	close(code?: number, reason?: string): void {
		this.closed = { code, reason };
	}
	onOpen(handler: () => void): void {
		this.open = handler;
	}
	onMessage(handler: (data: string) => void): void {
		this.message = handler;
	}
	onClose(handler: (code: number, reason: string) => void): void {
		this.close_ = handler;
	}
	onError(): void {
		/* driven explicitly in these tests */
	}

	/** Test driver: the server accepted the upgrade. */
	fireOpen(): void {
		this.open?.();
	}
	fireMessage(message: unknown): void {
		this.message?.(JSON.stringify(message));
	}
	fireClose(code = 1006, reason = "gone"): void {
		this.close_?.(code, reason);
	}
	frames(): Array<Record<string, unknown>> {
		return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
	}
}

/** A clock the test advances by hand, so no test waits on a real timer. */
class TestScheduler implements Scheduler {
	private queue: Array<{ id: number; at: number; fn: () => void }> = [];
	private nextId = 1;
	now = 0;

	setTimeout(fn: () => void, ms: number): unknown {
		const id = this.nextId++;
		this.queue.push({ id, at: this.now + ms, fn });
		return id;
	}
	clearTimeout(handle: unknown): void {
		this.queue = this.queue.filter((entry) => entry.id !== handle);
	}
	advance(ms: number): void {
		const target = this.now + ms;
		let due = this.queue.filter((entry) => entry.at <= target).sort((a, b) => a.at - b.at);
		while (due.length > 0) {
			const next = due[0];
			this.queue = this.queue.filter((entry) => entry.id !== next.id);
			this.now = next.at;
			next.fn();
			due = this.queue.filter((entry) => entry.at <= target).sort((a, b) => a.at - b.at);
		}
		this.now = target;
	}
	get pending(): number {
		return this.queue.length;
	}
}

const register = {
	machine_name: "studio",
	os: "linux 6.8",
	daemon_version: "0.16.1",
	host_agents: [{ name: "claude-code" as const, version: "2.1.0" }],
	working_dirs: ["/work/repo"],
	cached_policies: [],
};

function event(jobId: string, text: string): WireEvent {
	return {
		job_id: jobId,
		seq: 0,
		ts: "2026-08-01T00:00:00.000Z",
		source: "daemon",
		kind: "agent.thought.streamed",
		text,
	} as WireEvent;
}

function harness(options: { forgetToken?: () => void } = {}) {
	const sockets: FakeSocket[] = [];
	const scheduler = new TestScheduler();
	const connection = new DaemonConnection({
		url: "wss://gw.example/v1/daemon",
		token: "pxis_secret",
		register,
		socketFactory: () => {
			const socket = new FakeSocket();
			sockets.push(socket);
			return socket;
		},
		scheduler,
		now: () => scheduler.now,
		random: () => 1, // no jitter, so the schedule in a test is the schedule
		forgetToken: options.forgetToken,
	});
	return { connection, sockets, scheduler, current: () => sockets[sockets.length - 1] };
}

/** Brings a connection to the point where the server has accepted it. */
function bringOnline(h: ReturnType<typeof harness>): void {
	h.connection.start();
	h.current().fireOpen();
	h.current().fireMessage({ type: "registered", machine_id: "mach_1" });
}

describe("registering", () => {
	it("introduces the machine as its first frame, and only claims", () => {
		const h = harness();
		h.connection.start();
		h.current().fireOpen();

		const first = h.current().frames()[0];
		expect(first.type).toBe("register");
		expect(first.machine_name).toBe("studio");
		expect(first.working_dirs).toEqual(["/work/repo"]);
		// The token authenticates the socket; it is not repeated in the payload.
		expect(JSON.stringify(first)).not.toContain("pxis_secret");
	});

	it("is online only once the workspace says so", () => {
		const h = harness();
		h.connection.start();
		expect(h.connection.currentState).toBe("connecting");
		h.current().fireOpen();
		expect(h.connection.currentState).toBe("registering");
		h.current().fireMessage({ type: "registered", machine_id: "mach_1" });
		expect(h.connection.currentState).toBe("online");
	});

	it("beats at the cadence the gateway counts in", () => {
		const h = harness();
		bringOnline(h);
		h.connection.emit(event("job_1", "working"));

		h.scheduler.advance(HEARTBEAT_MS);
		const heartbeat = h.current().frames().find((f) => f.type === "heartbeat");
		expect(heartbeat).toBeDefined();
		expect(heartbeat?.running_jobs).toEqual(["job_1"]);
	});
});

describe("a dropped connection", () => {
	it("keeps accepting events while offline and replays them in order", () => {
		const h = harness();
		bringOnline(h);
		h.current().fireClose();

		h.connection.emit(event("job_1", "one"));
		h.connection.emit(event("job_1", "two"));
		expect(h.connection.queuedCount).toBe(2);

		h.scheduler.advance(BACKOFF_MAX_MS);
		h.current().fireOpen();
		h.current().fireMessage({ type: "registered", machine_id: "mach_1" });

		const replayed = h
			.current()
			.frames()
			.filter((f) => f.type === "event")
			.map((f) => (f.event as { text: string; seq: number }));
		expect(replayed.map((e) => e.text)).toEqual(["one", "two"]);
		// Its own counter, so the ack can name exactly what is durable.
		expect(replayed.map((e) => e.seq)).toEqual([1, 2]);
	});

	it("holds an event until the server says it is durable, not until it is sent", () => {
		const h = harness();
		bringOnline(h);
		h.connection.emit(event("job_1", "one"));
		expect(h.connection.queuedCount).toBe(1);

		h.current().fireMessage({ type: "ack", job_id: "job_1", seq: 1 });
		expect(h.connection.queuedCount).toBe(0);
	});

	it("replays only what was never acknowledged", () => {
		const h = harness();
		bringOnline(h);
		h.connection.emit(event("job_1", "one"));
		h.connection.emit(event("job_1", "two"));
		h.current().fireMessage({ type: "ack", job_id: "job_1", seq: 1 });
		h.current().fireClose();

		h.scheduler.advance(BACKOFF_MAX_MS);
		h.current().fireOpen();
		h.current().fireMessage({ type: "registered", machine_id: "mach_1" });

		const texts = h
			.current()
			.frames()
			.filter((f) => f.type === "event")
			.map((f) => (f.event as { text: string }).text);
		expect(texts).toEqual(["two"]);
	});

	it("backs off, and the backoff has a ceiling", () => {
		const h = harness();
		bringOnline(h);

		for (let i = 0; i < 10; i++) {
			h.current().fireClose();
			h.scheduler.advance(BACKOFF_MAX_MS);
			h.current().fireOpen();
			h.current().fireMessage({ type: "registered", machine_id: "mach_1" });
		}
		// Eleven sockets: the first plus one per reconnection. A daemon that
		// stopped retrying would show fewer, one that spun would show far more.
		expect(h.sockets.length).toBe(11);
	});

	it("sheds the oldest events rather than growing without limit, and says how many", () => {
		const dropped: Array<{ jobId: string; count: number }> = [];
		const scheduler = new TestScheduler();
		const connection = new DaemonConnection({
			url: "wss://gw.example/v1/daemon",
			token: "t",
			register,
			socketFactory: () => new FakeSocket(),
			scheduler,
			handlers: { onDropped: (jobId, count) => dropped.push({ jobId, count }) },
		});

		for (let i = 0; i < MAX_QUEUED_PER_JOB + 5; i++) connection.emit(event("job_1", `e${i}`));

		expect(connection.queuedCount).toBe(MAX_QUEUED_PER_JOB);
		expect(dropped.reduce((sum, d) => sum + d.count, 0)).toBe(5);
	});
});

describe("being told to stop", () => {
	it("forgets the token when revoked and does not reconnect", () => {
		let forgotten = false;
		const h = harness({ forgetToken: () => { forgotten = true; } });
		bringOnline(h);

		h.current().fireMessage({ type: "revoke" });

		expect(forgotten).toBe(true);
		expect(h.connection.currentState).toBe("revoked");
		h.scheduler.advance(BACKOFF_MAX_MS * 4);
		expect(h.sockets.length).toBe(1);
		expect(h.scheduler.pending).toBe(0);
	});

	it("stops for good on a wire version refusal instead of hammering", () => {
		// The server already said no and said what to do about it. Retrying
		// would bury that message under a reconnect loop.
		const h = harness();
		h.connection.start();
		h.current().fireOpen();
		h.current().fireClose(4010, "wire version not supported");

		expect(h.connection.currentState).toBe("stopped");
		h.scheduler.advance(BACKOFF_MAX_MS * 4);
		expect(h.sockets.length).toBe(1);
	});

	it("leaves nothing running after stop()", () => {
		const h = harness();
		bringOnline(h);
		h.connection.stop();

		expect(h.scheduler.pending).toBe(0);
		expect(h.current().closed?.code).toBe(1000);
	});
});

describe("the consented scope", () => {
	it("admits a directory and what is under it", () => {
		const scope = consentedDirs(["/work/repo"]);
		expect(isWithinScope("/work/repo", scope)).toBe(true);
		expect(isWithinScope("/work/repo/src/index.ts", scope)).toBe(true);
	});

	it("does not admit a sibling that merely starts with the same letters", () => {
		// A prefix check without a separator boundary would let /work/repo
		// consent to /work/repo-of-someone-else.
		const scope = consentedDirs(["/work/repo"]);
		expect(isWithinScope("/work/repo-of-someone-else/secrets", scope)).toBe(false);
	});

	it("admits nothing when nothing was consented to", () => {
		// The default is empty, and empty means empty. A daemon that treated an
		// unspecified scope as "everything" would ship a home directory.
		expect(isWithinScope("/anything", consentedDirs([]))).toBe(false);
	});

	it("does not escape the scope through a relative path", () => {
		const scope = consentedDirs(["/work/repo"]);
		expect(isWithinScope("/work/repo/../../etc/passwd", scope)).toBe(false);
	});
});
