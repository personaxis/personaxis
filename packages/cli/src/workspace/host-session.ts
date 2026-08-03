/**
 * Running the host agent for a job the workspace sent.
 *
 * This is the half of the daemon that acts. The other half already existed: the
 * hook refuses a tool call before it runs, which works whether the call came
 * from a person typing in their terminal or from here. What was missing is
 * anything that starts the agent at all, so until now a workspace could watch a
 * machine and never give it work.
 *
 * The shape is deliberately small. Spawn the vendor's binary, read its stream a
 * line at a time, hand each line to the translator, and report what comes back.
 * Everything else that could live here lives somewhere better: the wire envelope
 * and the scope guard are the reporter's, the policy is the hook's, and the
 * translation is a pure function with its own tests.
 *
 * ## Two things it guarantees, and both are about the end
 *
 * **The room always finds out the job is over.** If the agent exits without
 * saying so, exits from a signal, or never starts because the binary is not
 * there, a session end is emitted anyway. A job that hangs open forever is worse
 * than a failed one: nobody can tell it apart from work still in progress, and
 * the person watching keeps waiting.
 *
 * **The agent does not outlive the daemon.** An orphaned agent still holds the
 * consented directories and still calls tools, with the one thing that refuses
 * calls no longer running. That is precisely the situation this product exists
 * to make impossible, so the child is killed on the way out of every exit path.
 */

import { type ChildProcess, spawn } from "node:child_process";

import type { WireEmission } from "@personaxis/core";

import { HostStreamTranslator, type SkipReason } from "./host-stream.js";

/** How the run ended, for the caller. The room learns it through the wire. */
export type SessionOutcome = "completed" | "failed" | "stopped";

export interface HostSessionOptions {
	/** The agent binary. Named by the adapter, never guessed at here. */
	command: string;
	/** Everything except the prompt, which is appended last. */
	args: readonly string[];
	prompt: string;
	/** The directory the agent runs in. One of the consented ones. */
	cwd: string;
	/** Where translated events go. Normally `JobReporter.reportWire`. */
	emit: (body: WireEmission) => void;
	/** Told about lines that produced nothing, with the reason. */
	onSkip?: (reason: SkipReason, detail: string) => void;
	/**
	 * How long the agent may run before it is stopped.
	 *
	 * A run with no ceiling is a run that can hold a machine and a budget open
	 * until somebody notices, and noticing is exactly what nobody does at night,
	 * which is when the triggers fire.
	 */
	timeoutMs?: number;
	env?: NodeJS.ProcessEnv;
	/** Injected for tests. */
	spawnFn?: typeof spawn;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export class HostSession {
	private child: ChildProcess | null = null;
	private readonly translator: HostStreamTranslator;
	/** stdout arrives in chunks, not lines. What is left over waits here. */
	private buffer = "";
	/** The host's own last words when it fails to start. */
	private stderr = "";
	private ended = false;
	private stopping = false;
	private releaseExitHooks: (() => void) | null = null;

	constructor(private readonly options: HostSessionOptions) {
		this.translator = new HostStreamTranslator({ onSkip: options.onSkip });
	}

	/** Turns taken, once the run is over. */
	get turns(): number {
		return this.translator.turns;
	}

	/**
	 * Run to completion.
	 *
	 * Resolves rather than rejects on a failed run: a failure is an outcome the
	 * room needs reported, not an exception for the caller to translate a second
	 * time.
	 */
	run(): Promise<SessionOutcome> {
		return new Promise<SessionOutcome>((resolve) => {
			const spawnFn = this.options.spawnFn ?? spawn;
			const finish = (outcome: SessionOutcome, reason?: string) => {
				this.clearTimer();
				this.releaseExitHooks?.();
				this.releaseExitHooks = null;
				this.endSession(outcome, reason);
				resolve(outcome);
			};

			let child: ChildProcess;
			try {
				child = spawnFn(this.options.command, [...this.options.args, this.options.prompt], {
					cwd: this.options.cwd,
					env: this.options.env,
					stdio: ["ignore", "pipe", "pipe"],
				});
			} catch (error) {
				// Synchronous throws happen: a command that is not a string, an
				// invalid cwd. ENOENT arrives on the error event instead, and both
				// have to end the session or the room waits forever.
				finish("failed", `could not start the agent: ${String(error)}`);
				return;
			}

			this.child = child;
			this.installExitHooks();

			child.stdout?.setEncoding("utf8");
			child.stdout?.on("data", (chunk: string) => this.consume(chunk));
			// Kept rather than piped through: it is where a host writes the reason
			// it could not start, and a failure whose reason went nowhere is a
			// failure nobody can act on. Bounded, because it is unbounded input.
			child.stderr?.setEncoding("utf8");
			child.stderr?.on("data", (chunk: string) => {
				if (this.stderr.length < 4000) this.stderr += chunk;
			});

			child.on("error", (error) => finish("failed", `could not start the agent: ${error.message}`));

			child.on("close", (code, signal) => {
				// Whatever is left in the buffer is a final line with no newline.
				this.consume("\n");

				if (this.stopping) return finish("stopped", "stopped by the workspace");
				if (signal) return finish("failed", `the agent was killed by ${signal}`);
				if (code === 0) return finish("completed");
				return finish("failed", this.stderr.trim() || `the agent exited with code ${code}`);
			});

			this.startTimer(() => {
				this.stopping = true;
				this.kill();
				finish("stopped", "the run reached its time limit");
			});
		});
	}

	/** Stop the run. The room is told it was stopped, not that it failed. */
	stop(): void {
		this.stopping = true;
		this.kill();
	}

	// ── internals ───────────────────────────────────────────────────────────

	private consume(chunk: string): void {
		this.buffer += chunk;
		let index = this.buffer.indexOf("\n");
		while (index !== -1) {
			const line = this.buffer.slice(0, index);
			this.buffer = this.buffer.slice(index + 1);
			for (const body of this.translator.translate(line)) {
				if (body.kind === "persona.session.ended") {
					// The agent said it is done. Recorded so the exit path does not
					// report the end a second time with a different status.
					this.ended = true;
				}
				this.options.emit(body);
			}
			index = this.buffer.indexOf("\n");
		}
	}

	/**
	 * Say the job is over, unless the agent already did.
	 *
	 * The two orders both happen: a clean run ends itself and then exits, and a
	 * killed one exits with nothing said. Emitting twice would leave the room
	 * with two endings and a record that disagrees with itself about which.
	 */
	private endSession(outcome: SessionOutcome, reason?: string): void {
		if (this.ended) return;
		this.ended = true;
		this.options.emit({
			kind: "persona.session.ended",
			status: outcome === "completed" ? "completed" : outcome === "stopped" ? "stopped" : "failed",
			...(reason ? { reason } : {}),
		} as WireEmission);
	}

	private kill(): void {
		if (!this.child || this.child.killed) return;
		this.child.kill("SIGTERM");
	}

	private timer: NodeJS.Timeout | null = null;

	private startTimer(onTimeout: () => void): void {
		const ms = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.timer = setTimeout(onTimeout, ms);
		// Never hold the process open on its own account: a daemon that cannot
		// exit because a timer is pending is a daemon somebody kills with -9,
		// and that is the path where children are orphaned.
		this.timer.unref?.();
	}

	private clearTimer(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
	}

	/**
	 * Kill the agent if this process goes away.
	 *
	 * Registered per run and removed when the run ends, because a daemon that
	 * runs many jobs would otherwise accumulate one listener per job and hit
	 * Node's warning, which is the visible half of a real leak.
	 */
	private installExitHooks(): void {
		const onExit = () => this.kill();
		process.once("exit", onExit);
		process.once("SIGINT", onExit);
		process.once("SIGTERM", onExit);
		this.releaseExitHooks = () => {
			process.off("exit", onExit);
			process.off("SIGINT", onExit);
			process.off("SIGTERM", onExit);
		};
	}
}
