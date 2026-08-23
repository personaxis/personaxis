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
 * The workspace may now PROPOSE a directory, because a project is a boundary and one that
 * stops at the folder is not a boundary: every project ran in `scope[0]`, so two clients'
 * work landed in the same folder and edited each other's files.
 *
 * What it may not do is CHOOSE one. Every proposal is checked against what the operator
 * typed at `connect`, and anything outside it is refused rather than quietly clamped to a
 * directory nobody asked for. A workspace, or anything that has compromised one, must not
 * be able to pick where a process starts on somebody else's machine. That is the whole
 * daemon boundary, it lives in `directoryFor` below, and the test that proves it names the
 * attack.
 *
 * ## Refusing is an event, not silence
 *
 * A job that cannot run says so on the wire: no host installed, no consented directory,
 * already running something. The alternative is a job that sits in the workspace looking
 * queued forever while the machine that was supposed to run it has already decided it
 * will not, which is indistinguishable from a machine that went offline.
 */

import type { CompiledPolicy } from "@personaxis/core";
import type { HostAgentName, ServerToDaemonMsg } from "@personaxis/protocol/workspace";

import { HostSession } from "./host-session.js";
import { describePolicyProblem, policyFromRef } from "./policy-from-ref.js";
import { describeFile, kindOf, producedBetween, scanDirectory } from "./produced-files.js";
import { withinScope } from "./scope-guard.js";
import { JobReporter, type ReporterSink } from "./job-reporter.js";

/**
 * How long the daemon will spend naming what a step produced before ending it
 * anyway.
 *
 * Two seconds is generous for a bounded walk of a project directory and short
 * enough that nobody watching a run wonders whether it hung. What it protects
 * against is a network drive or a directory this scan's skip list does not know
 * about yet: the file list is worth having and is never worth holding a finished
 * job open for.
 */
const NAMING_BUDGET_MS = 2_000;

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
	/**
	 * Where the policy that came with a job goes.
	 *
	 * The runner does not own the cache: the hook answers from it, `connect` builds
	 * it, and this only hands over what arrived. Passing the cache itself would let a
	 * job runner evict or rewrite policies for jobs that are not its own.
	 */
	onPolicy?: (policy: CompiledPolicy, cwd: string) => void;
	/**
	 * A person answered a gate, by its id.
	 *
	 * Routed rather than handled here, because what waits on the answer is the
	 * hook's request and not the run: the run carries the question outward and has
	 * nothing to do with the reply.
	 */
	onGateResolved?: (gateId: string, outcome: "approved" | "denied" | "expired") => void;
	/**
	 * A run ended, so anything still waiting on a person there has nobody left to
	 * answer it. Refusing beats holding a hook open on a process that is gone.
	 */
	onJobEnded?: (jobId: string) => void;
	timeoutMs?: number;
	now?: () => Date;
	/** Injected for tests. */
	createSession?: (options: ConstructorParameters<typeof HostSession>[0]) => HostSession;
}

interface RunningJob {
	session: HostSession;
	reporter: JobReporter;
	/**
	 * Where it is running.
	 *
	 * Kept so a hook call can be joined to a run. The hook is spawned inside a
	 * directory and that is the only thing it reliably knows, so the directory is
	 * the join, and without it a gate has no run to be an event on.
	 */
	cwd: string;
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
		else if (message.type === "gate.resolved") {
			// A person answered. Until this line existed the message arrived and
			// nothing matched on it, which is the same shape of bug as `job.assign`
			// before there was a runner: a wire that carries a decision to a process
			// that ignores it.
			this.options.onGateResolved?.(message.gate_id, message.outcome);
		}
	}

	/**
	 * The run in flight in a directory, if there is one.
	 *
	 * A directory holds at most one, because a second agent in the same folder is
	 * two processes editing each other's files, which `assign` already refuses.
	 */
	runFor(cwd: string): { jobId: string; reporter: JobReporter } | null {
		for (const [jobId, job] of this.running) {
			if (job.cwd === cwd || withinScope(cwd, [job.cwd])) return { jobId, reporter: job.reporter };
		}
		return null;
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

		const cwd = this.directoryFor(message.working_dir);
		if (!cwd) {
			return this.refuse(
				reporter,
				message.working_dir
					? `the workspace asked for ${message.working_dir}, which this machine did not consent to expose`
					: "this machine exposed no directories at connect, so there is nowhere to run",
			);
		}

		const launch = this.options.launcher(this.options.host);
		if (!launch) {
			return this.refuse(reporter, `no ${this.options.host} agent is installed on this machine`);
		}

		const instruction = readPrompt(message.trigger_context);
		if (!instruction) {
			// An agent started with an empty prompt does something arbitrary, in a real
			// directory, with real tools.
			return this.refuse(reporter, "the job carried no prompt");
		}

		// The policy reaches the hook before the agent starts, never after.
		//
		// The hook decides every tool call against the cache, so a session that began
		// before its policy landed would be a session enforcing whatever was cached
		// from something else, or nothing at all. The order here is the guarantee.
		//
		// And a policy that does not match its own hash is refused rather than used.
		// Enforcing one nobody wrote is worse than enforcing none, because the hook
		// would report every decision it made with complete confidence.
		const policy = policyFromRef(message.policy);
		if (!policy.ok) return this.refuse(reporter, describePolicyProblem(policy.problem));
		// With the directory, because a policy the machine cannot place is a policy it
		// cannot apply: the hook asks by working directory, not by persona.
		this.options.onPolicy?.(policy.policy, cwd);

		const prompt = withPersona(message.persona_document, instruction);

		const create = this.options.createSession ?? ((options) => new HostSession(options));
		const session = create({
			command: launch.command,
			args: launch.args,
			prompt,
			cwd,
			emit: (body) => {
				// Everything except the ending goes straight through.
				if (body.kind !== "persona.session.ended") {
					reporter.reportWire(body);
					return;
				}

				// The ending is HELD until the files are named, and the order is not
				// cosmetic. `persona.session.ended` is the reporter's terminal event:
				// it releases the connection's queue for this job, and the workspace
				// moves the row to its final status on it. Anything emitted after is
				// a late event arriving at a job that is already over, which the
				// record writer correctly ignores. Naming the files afterwards would
				// have meant naming them into nothing.
				void this.endAfterNamingFiles(reporter, cwd, before, body);
			},
			...(this.options.timeoutMs ? { timeoutMs: this.options.timeoutMs } : {}),
		});

		this.running.set(jobId, { session, reporter, cwd });

		// What the step leaves behind, named after it finishes.
		//
		// Taken before and after rather than watched: a watcher on somebody else's
		// repository is a file handle per directory for as long as the job runs, and
		// what this needs is the difference between two moments, not every event in
		// between.
		//
		// The scan is fired and not awaited before the run, so a large project does
		// not delay the agent starting. If it has not finished by the time the run
		// ends, the comparison waits for it, which is the only ordering that can be
		// correct: without a "before" there is no way to tell a file the step wrote
		// from a file that was already there.
		const before = scanDirectory(cwd);

		void session.run().finally(() => {
			this.running.delete(jobId);
			this.options.onJobEnded?.(jobId);
		});
	}

	/**
	 * Where this job runs.
	 *
	 * The workspace may PROPOSE a directory, because a project is a boundary and a
	 * boundary that stops at the folder is not one: every project ran in `scope[0]`,
	 * so two clients' work landed in the same folder and edited each other's files.
	 *
	 * What it may not do is choose one. The proposal is checked against what this
	 * machine consented to at its own keyboard, and anything outside is refused
	 * rather than clamped to a directory nobody asked for. Silently falling back
	 * would be worse than refusing: the job would run, in the wrong place, and look
	 * like it worked.
	 *
	 * No proposal means the first consented directory, which is what every daemon
	 * did before this field existed.
	 */
	private directoryFor(proposed: string | undefined): string | null {
		if (!proposed) return this.options.scope[0] ?? null;
		return withinScope(proposed, this.options.scope) ? proposed : null;
	}

	private stop(jobId: string): void {
		// A stop for a job that is not running is not an error: the workspace may have sent
		// it while the run was already ending. Answering would be inventing an event.
		this.running.get(jobId)?.session.stop();
	}

	/**
	 * Says which files appeared, and never sends one.
	 *
	 * The bytes stay on this machine. That is the decision and not a limitation:
	 * the connected mode is sold on nothing leaving the operator's computer, and a
	 * delivery that quietly uploaded a client's work would make that sentence
	 * false. So what crosses the wire is that a file exists, what kind it is and
	 * how big, which is enough for a person to know the step produced something
	 * and to go and open it.
	 *
	 * Failures here are swallowed on purpose, and this is the one place in this
	 * file where that is right: the run has already ended and been reported. A
	 * scan that throws on an unreadable directory must not turn a finished job
	 * into a crash after the fact.
	 */
	/**
	 * Names the files, then ends the job.
	 *
	 * A ceiling on the scan, because this now sits between a finished run and the
	 * event that tells the workspace it finished. A directory that takes forever
	 * to walk must not be able to hold a job open: past the deadline the ending
	 * goes out without the file list, which loses a nice-to-have rather than the
	 * fact that the work is done.
	 */
	private async endAfterNamingFiles(
		reporter: JobReporter,
		cwd: string,
		before: Promise<Awaited<ReturnType<typeof scanDirectory>>>,
		ending: Parameters<JobReporter["reportWire"]>[0],
	): Promise<void> {
		const deadline = new Promise<void>((resolve) => {
			setTimeout(resolve, NAMING_BUDGET_MS).unref?.();
		});

		await Promise.race([this.reportProduced(reporter, cwd, before), deadline]);
		reporter.reportWire(ending);
	}

	private async reportProduced(
		reporter: JobReporter,
		cwd: string,
		before: Promise<Awaited<ReturnType<typeof scanDirectory>>>,
	): Promise<void> {
		try {
			const [was, now] = await Promise.all([before, scanDirectory(cwd)]);
			const produced = producedBetween(was, now);

			for (const file of produced) {
				reporter.reportWire({
					kind: "artifact.created",
					// Derived from the path, so the same file written twice by two runs
					// is two events that can be told apart by their job and matched to
					// each other by their id.
					artifact_id: `file:${file.path}`,
					artifact_kind: kindOf(file.path),
					preview: describeFile(file),
					path: file.path,
					bytes: file.bytes,
				});
			}
		} catch {
			// See above: the job is already finished and already reported.
		}
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
/**
 * The instruction, preceded by who is carrying it out.
 *
 * A host agent takes one prompt. Without the persona in it, what runs is a generic
 * agent doing a task: the character, the way of working and the things it never does
 * are all in a document nothing ever read. The limits would still hold, because the
 * hook enforces those before each call, but the difference between a worker and a
 * task runner is exactly this text.
 *
 * The separator is explicit and the instruction is labelled. An agent handed two
 * blocks of prose with no marking treats the first as context for the second, which
 * is nearly right and fails in the case that matters: a persona document that
 * happens to contain an imperative sentence.
 */
function withPersona(document: string | undefined, instruction: string): string {
	const identity = document?.trim();
	if (!identity) return instruction;

	return [
		identity,
		"",
		"---",
		"",
		"What you have been asked to do in this run:",
		"",
		instruction,
	].join("\n");
}

function readPrompt(context: Record<string, unknown>): string | null {
	const value = context?.prompt;
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}
