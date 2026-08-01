/**
 * The daemon's end of the wire.
 *
 * One socket, dialled out from the machine. Nothing listens locally, no port is
 * opened, and a corporate network that blocks inbound traffic is not a problem
 * because the connection originates inside it.
 *
 * The part worth reading is what happens when that socket drops, because it
 * drops constantly: laptops sleep, networks change, deploys cycle the gateway.
 * The rule is that a disconnection pauses reporting and nothing else. The job
 * keeps running, its events queue locally, and on reconnect the daemon replays
 * exactly what the server has not confirmed as durable. A daemon that stopped
 * work when it lost the workspace would make the workspace a single point of
 * failure for work happening on someone else's computer, which is precisely
 * what this architecture exists to avoid.
 *
 * Every dependency that touches the world (socket, clock, timers, randomness)
 * is injected. Reconnection logic that can only be exercised by unplugging a
 * cable is reconnection logic that is never exercised.
 */

import {
	WIRE_VERSION,
	type DaemonMsg,
	type ServerToDaemonMsg,
	type WireEvent,
} from "@personaxis/protocol/workspace";

/** Heartbeat cadence. The gateway calls a machine offline after three misses. */
export const HEARTBEAT_MS = 30_000;

/** First backoff step; it doubles from here. */
export const BACKOFF_MIN_MS = 1000;

/** Ceiling on backoff. Past this a daemon is just noise on someone's network. */
export const BACKOFF_MAX_MS = 30_000;

/**
 * How many unacknowledged events one job may hold before the oldest are shed.
 *
 * Unbounded would be worse than lossy: a machine that stays offline for a day
 * would grow its queue until the process died, taking the running job with it.
 * When the bound bites, the daemon says so in the record rather than leaving a
 * silent hole.
 */
export const MAX_QUEUED_PER_JOB = 2000;

export interface DaemonSocket {
	send(data: string): void;
	close(code?: number, reason?: string): void;
	onOpen(handler: () => void): void;
	onMessage(handler: (data: string) => void): void;
	onClose(handler: (code: number, reason: string) => void): void;
	onError(handler: (error: unknown) => void): void;
}

export type SocketFactory = (url: string, token: string) => DaemonSocket;

export interface Scheduler {
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

export type ConnectionState =
	| "idle"
	| "connecting"
	| "registering"
	| "online"
	| "backoff"
	| "stopped"
	| "revoked";

export interface RegisterFrame {
	machine_name: string;
	os: string;
	daemon_version: string;
	host_agents: Array<{ name: "claude-code" | "codex"; version: string }>;
	working_dirs: string[];
	cached_policies: Array<{ persona_version_id: string; hash: string }>;
}

export interface ConnectionHandlers {
	/** Registration completed and the workspace named the machine. */
	onRegistered?: (machineId: string) => void;
	onStateChange?: (state: ConnectionState, detail?: string) => void;
	/** Everything the server sends that is not registration or an ack. */
	onServerMessage?: (message: ServerToDaemonMsg) => void;
	/** The workspace revoked this machine. The token is already gone locally. */
	onRevoked?: () => void;
	/** Called when the queue bound sheds events, with how many were lost. */
	onDropped?: (jobId: string, count: number) => void;
}

export interface ConnectionOptions {
	url: string;
	token: string;
	register: RegisterFrame;
	socketFactory: SocketFactory;
	scheduler?: Scheduler;
	now?: () => number;
	/** Full jitter on backoff, injected so a test sees a fixed schedule. */
	random?: () => number;
	handlers?: ConnectionHandlers;
	/** Deletes the local token when the workspace revokes the machine. */
	forgetToken?: () => void;
}

interface QueuedEvent {
	seq: number;
	frame: string;
}

const realScheduler: Scheduler = {
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class DaemonConnection {
	private readonly options: Required<Omit<ConnectionOptions, "handlers" | "forgetToken">> &
		Pick<ConnectionOptions, "handlers" | "forgetToken">;

	private socket: DaemonSocket | null = null;
	private state: ConnectionState = "idle";
	private attempt = 0;
	private heartbeatHandle: unknown = null;
	private reconnectHandle: unknown = null;
	private runningJobs = new Set<string>();

	/** Per job: the next counter to stamp, and what has not been acknowledged. */
	private nextSeq = new Map<string, number>();
	private pending = new Map<string, QueuedEvent[]>();

	constructor(options: ConnectionOptions) {
		this.options = {
			scheduler: realScheduler,
			now: () => Date.now(),
			random: Math.random,
			...options,
		};
	}

	get currentState(): ConnectionState {
		return this.state;
	}

	/** Events waiting for an ack, for a status line that must not guess. */
	get queuedCount(): number {
		let total = 0;
		for (const queue of this.pending.values()) total += queue.length;
		return total;
	}

	start(): void {
		if (this.state === "stopped" || this.state === "revoked") return;
		this.open();
	}

	/** Local shutdown. The machine stays registered; it is simply not connected. */
	stop(): void {
		this.transition("stopped");
		this.clearTimers();
		this.socket?.close(1000, "daemon stopping");
		this.socket = null;
	}

	/**
	 * Reports an event.
	 *
	 * Always accepted, online or not. The caller is a running job and has
	 * nowhere else to put this; refusing would push the buffering problem into
	 * every producer.
	 */
	emit(event: WireEvent): void {
		const jobId = event.job_id;
		const seq = this.nextSeq.get(jobId) ?? 1;
		this.nextSeq.set(jobId, seq + 1);
		this.runningJobs.add(jobId);

		const message: DaemonMsg = { type: "event", event: { ...event, seq } };
		const queue = this.pending.get(jobId) ?? [];
		queue.push({ seq, frame: JSON.stringify(message) });

		if (queue.length > MAX_QUEUED_PER_JOB) {
			const dropped = queue.splice(0, queue.length - MAX_QUEUED_PER_JOB);
			this.options.handlers?.onDropped?.(jobId, dropped.length);
		}
		this.pending.set(jobId, queue);

		if (this.state === "online") this.flush(jobId);
	}

	/** Marks a job finished, so its queue and counter are not kept forever. */
	finishJob(jobId: string): void {
		this.runningJobs.delete(jobId);
		if ((this.pending.get(jobId)?.length ?? 0) === 0) {
			this.pending.delete(jobId);
			this.nextSeq.delete(jobId);
		}
	}

	private open(): void {
		this.transition("connecting");
		const socket = this.options.socketFactory(this.options.url, this.options.token);
		this.socket = socket;

		socket.onOpen(() => {
			this.transition("registering");
			this.send({ type: "register", wire_version: WIRE_VERSION, ...this.options.register });
		});

		socket.onMessage((data) => this.receive(data));

		socket.onClose((code, reason) => {
			if (this.state === "stopped" || this.state === "revoked") return;
			// 4010 is the gateway refusing this wire version. Retrying would loop
			// forever against a server that already said no, so the daemon stops
			// and the operator sees the upgrade instruction it sent.
			if (code === 4010) {
				this.transition("stopped", reason || "wire version not supported");
				this.clearTimers();
				return;
			}
			this.scheduleReconnect(reason || `socket closed (${code})`);
		});

		socket.onError(() => {
			// Errors arrive before close on some transports and instead of close on
			// others. Reconnection is driven from close alone, so this only has to
			// not throw.
		});
	}

	private receive(data: string): void {
		let message: ServerToDaemonMsg;
		try {
			message = JSON.parse(data) as ServerToDaemonMsg;
		} catch {
			return;
		}

		switch (message.type) {
			case "registered":
				this.attempt = 0;
				this.transition("online");
				this.options.handlers?.onRegistered?.(message.machine_id);
				this.startHeartbeat();
				// Everything buffered while offline goes now, in order, before any
				// new event can be produced.
				for (const jobId of this.pending.keys()) this.flush(jobId);
				return;

			case "ack": {
				const queue = this.pending.get(message.job_id);
				if (!queue) return;
				const remaining = queue.filter((entry) => entry.seq > message.seq);
				if (remaining.length === 0 && !this.runningJobs.has(message.job_id)) {
					this.pending.delete(message.job_id);
					this.nextSeq.delete(message.job_id);
				} else {
					this.pending.set(message.job_id, remaining);
				}
				return;
			}

			case "revoke":
				// The order matters: forget the credential first, then close. A
				// close handler that fired before the token was gone would start a
				// reconnect with a token the workspace already refused.
				this.transition("revoked", "this machine was revoked in the workspace");
				this.clearTimers();
				try {
					this.options.forgetToken?.();
				} finally {
					this.socket?.close(1000, "revoked");
					this.socket = null;
					this.options.handlers?.onRevoked?.();
				}
				return;

			default:
				this.options.handlers?.onServerMessage?.(message);
		}
	}

	private flush(jobId: string): void {
		const queue = this.pending.get(jobId);
		if (!queue || this.state !== "online") return;
		for (const entry of queue) {
			// Left in the queue after sending. A write that the socket accepted is
			// not a write that reached storage, and only the ack says otherwise.
			this.rawSend(entry.frame);
		}
	}

	private startHeartbeat(): void {
		this.options.scheduler.clearTimeout(this.heartbeatHandle);
		const beat = () => {
			if (this.state !== "online") return;
			this.send({ type: "heartbeat", running_jobs: [...this.runningJobs] });
			this.heartbeatHandle = this.options.scheduler.setTimeout(beat, HEARTBEAT_MS);
		};
		this.heartbeatHandle = this.options.scheduler.setTimeout(beat, HEARTBEAT_MS);
	}

	/**
	 * Backs off with full jitter.
	 *
	 * Jitter is not decoration here: a gateway deploy disconnects every daemon in
	 * the same second, and a fleet that all retried on the same doubling schedule
	 * would reconnect in a thundering herd precisely when the new instance is
	 * coldest.
	 */
	private scheduleReconnect(reason: string): void {
		this.socket = null;
		this.options.scheduler.clearTimeout(this.heartbeatHandle);
		this.attempt += 1;
		const ceiling = Math.min(BACKOFF_MIN_MS * 2 ** (this.attempt - 1), BACKOFF_MAX_MS);
		const delay = Math.max(BACKOFF_MIN_MS, Math.floor(this.options.random() * ceiling));
		this.transition("backoff", `${reason}, retrying in ${Math.round(delay / 1000)}s`);
		this.reconnectHandle = this.options.scheduler.setTimeout(() => {
			if (this.state === "stopped" || this.state === "revoked") return;
			this.open();
		}, delay);
	}

	private clearTimers(): void {
		this.options.scheduler.clearTimeout(this.heartbeatHandle);
		this.options.scheduler.clearTimeout(this.reconnectHandle);
		this.heartbeatHandle = null;
		this.reconnectHandle = null;
	}

	private send(message: DaemonMsg): void {
		this.rawSend(JSON.stringify(message));
	}

	private rawSend(frame: string): void {
		try {
			this.socket?.send(frame);
		} catch {
			// The socket is gone but has not told us yet. The close handler will,
			// and the queue still holds everything unacknowledged.
		}
	}

	private transition(state: ConnectionState, detail?: string): void {
		if (this.state === state) return;
		this.state = state;
		this.options.handlers?.onStateChange?.(state, detail);
	}
}
