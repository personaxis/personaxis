/**
 * Doing what the workspace asked.
 *
 * The daemon has been able to hear `job.assign` since the protocol was written and has
 * done nothing with it: the message was defined, the socket carried it, and no code
 * matched on it. Everything else was in place, which is why nobody noticed. This is the
 * piece that turns a message into a running agent, and it is the difference between a
 * workspace that watches a machine and one that can give it work.
 *
 * ## The consented scope is not negotiable, and this is where that is enforced
 *
 * The directory an agent runs in comes from what the operator typed at `connect`, never
 * from the message. `job.assign` carries a trigger context written elsewhere, and a
 * workspace, or anything that has compromised one, must not be able to pick the directory
 * a process starts in. That is the whole daemon boundary in one line of code, so it is
 * written once, here, and the test that proves it names the attack.
 *
 * ## Refusing is an event, not silence
 *
 * A job that cannot run says so on the wire: no host installed, no consented directory,
 * already running something. The alternative is a job that sits in the workspace looking
 * queued forever while the machine that was supposed to run it has already decided it
 * will not, which is indistinguishable from a machine that went offline.
 */

import type { HostAgentName, ServerToDaemonMsg } from "@personaxis/protocol/workspace";

import { HostSession } from "./host-session.js";
import { JobReporter, type ReporterSink } from "./job-reporter.js";

/** How a given host agent is started. Absent means it is not installed here. */
export type HostLauncher = (host: HostAgentName) => { command: string; args: string[] } | null;

export interface JobRunnerOptions {
	/** Where events go. `DaemonConnection` is one. */
	sink: ReporterSink;
	/** The directories the operator consented to expose, in the order they were given. */
	scope: readonly string[];
	/** Which host agents this machine can start. */
	launcher: HostLauncher;
	/** Which host to use. The workspace does not get to choose it. */
	host: HostAgentName;
	/**
	 * How many agents may run at once.
	 *
	 * One by default. Several agents in the same working directory edit the same files
	 * with no idea the others exist, and the result is a mess nobody can attribute to a
	 * run afterwards. Raising this is a decision about a machine, made at that machine.
	 */
	maxConcurrent?: number;
	timeoutMs?: number;
	now?: () => Date;
	/** Injected for tests. */
	createSession?: (options: ConstructorParameters<typeof HostSession>[0]) => HostSession;
}

interface RunningJob {
	session: HostSession;
	reporter: JobReporter;
}

export class JobRunner {
	private readonly running = new Map<string, RunningJob>();

	constructor(private readonly options: JobRunnerOptions) {}

	/** Jobs in flight, for a status line. */
	get activeCount(): number {
		return this.running.size;
	}

	/** Route a message from the workspace. Anything else is somebody else's. */
	handle(message: ServerToDaemonMsg): void {
		if (message.type === "job.assign") this.assign(message);
		else if (message.type === "job.stop") this.stop(message.job_id);
	}

	private assign(message: Extract<ServerToDaemonMsg, { type: "job.assign" }>): void {
		const jobId = message.job_id;

		const reporter = new JobReporter({
			jobId,
			sink: this.options.sink,
			source: "daemon",
			scope: this.options.scope,
			...(this.options.now ? { now: this.options.now } : {}),
		});

		// The room is told the job started before anything can go wrong, so a refusal
		// arrives as a session that began and ended rather than as nothing at all.
		reporter.reportWire({
			kind: "persona.session.started",
			persona_id: message.persona_version_id,
			persona_version_id: message.persona_version_id,
			execution_location: "daemon",
		});

		if (this.running.has(jobId)) {
			// A duplicate assign, which a reconnect can produce. Starting a second agent
			// for one job would double every event in the record and leave two processes
			// editing the same files.
			return this.refuse(reporter, "this job is already running on this machine");
		}

		if (this.running.size >= (this.options.maxConcurrent ?? 1)) {
			return this.refuse(
				reporter,
				`this machine is already running ${this.running.size} job(s), which is all it allows at once`,
			);
		}

		// Never from the message. See the note at the top of the file.
		const cwd = this.options.scope[0];
		if (!cwd) {
			return this.refuse(
				reporter,
				"this machine exposed no directories at connect, so there is nowhere to run",
			);
		}

		const launch = this.options.launcher(this.options.host);
		if (!launch) {
			return this.refuse(reporter, `no ${this.options.host} agent is installed on this machine`);
		}

		const prompt = readPrompt(message.trigger_context);
		if (!prompt) {
			// An agent started with an empty prompt does something arbitrary, in a real
			// directory, with real tools.
			return this.refuse(reporter, "the job carried no prompt");
		}

		const create = this.options.createSession ?? ((options) => new HostSession(options));
		const session = create({
			command: launch.command,
			args: launch.args,
			prompt,
			cwd,
			emit: (body) => reporter.reportWire(body),
			...(this.options.timeoutMs ? { timeoutMs: this.options.timeoutMs } : {}),
		});

		this.running.set(jobId, { session, reporter });
		void session.run().finally(() => this.running.delete(jobId));
	}

	private stop(jobId: string): void {
		// A stop for a job that is not running is not an error: the workspace may have sent
		// it while the run was already ending. Answering would be inventing an event.
		this.running.get(jobId)?.session.stop();
	}

	private refuse(reporter: JobReporter, reason: string): void {
		reporter.reportWire({ kind: "persona.session.ended", status: "failed", reason });
	}
}

/**
 * The prompt out of the trigger context.
 *
 * Deliberately narrow: one key, a string, non-empty after trimming. A context that carries
 * something else is a job this daemon does not know how to run, and guessing at which of
 * its fields was meant to be the instruction is how an agent ends up acting on a webhook
 * payload somebody else wrote.
 */
function readPrompt(context: Record<string, unknown>): string | null {
	const value = context?.prompt;
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}
