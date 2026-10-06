/**
 * What this daemon was in the middle of when it stopped.
 *
 * `JobRunner` holds its running jobs in a `Map`, which is correct for everything
 * it does with them and gone the moment the process is. So a daemon that crashed
 * or was restarted came back knowing nothing, and the run it had been executing
 * stayed `running` in the workspace with nobody left who could ever end it.
 *
 * The gateway covers the other case, the one where the machine never comes back:
 * its heartbeat alarm seals those. It cannot cover this one. The alarm decides on
 * silence, and a daemon that restarts in ten seconds is not silent: the next
 * heartbeat moves the clock forward and reports the jobs it is running now, which
 * is none of them. Nothing then ever mentions the old run again.
 *
 * ## Written on the change, read once, deleted
 *
 * The file exists to survive exactly one event, so it is read at startup and
 * removed in the same breath. Leaving it would mean a second restart reporting
 * the same run again, and an ending arriving twice is the thing the room's seal
 * exists to refuse: better not to send it.
 *
 * ## It reports, it does not resume
 *
 * A restarted daemon cannot pick a run back up, and that is not a gap here. The
 * agent it was driving is gone with the process, and `personaAgent` says
 * `loadSession: false` out loud because a session that ended cannot be resumed.
 * So what a person is owed is the truth: this stopped, here is why, nothing after
 * this happened. Claiming anything else would be a run that looks recoverable and
 * is not.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { WireAuthor, WireEvent } from "@personaxis/protocol/workspace";

/** Named on every entry this file produces, so a record can be searched for them. */
export const RESTART_MECHANISM = "daemon-restart";

/**
 * A ceiling on what is carried across a restart.
 *
 * A daemon runs a handful of jobs at once. The bound is here because this file is
 * read at startup, before anything has validated it, and a corrupt or tampered
 * one must not turn a `connect` into thousands of events on the wire.
 */
export const MAX_CARRIED = 64;

export interface InFlightJob {
	job_id: string;
	/** ISO-8601, so the ending can say how long it had been going. */
	started_at: string;
}

export interface InFlightIO {
	home: () => string;
}

const defaultIO: InFlightIO = { home: homedir };

export function inFlightPath(io: InFlightIO = defaultIO): string {
	return join(io.home(), ".personaxis", "in-flight.json");
}

/**
 * Writes down what is running now.
 *
 * Beside and renamed over, never in place, for the same reason the device
 * credential is: a rename inside one directory is atomic, so a crash leaves the
 * old file or the new one and never half of either. Half of this one would parse
 * as no jobs at all, which is precisely the state it exists to correct.
 *
 * Failure is swallowed. This is bookkeeping for a case that has not happened yet,
 * and a disk that will not take it must not stop a run that is about to start.
 */
export function rememberInFlight(jobs: readonly InFlightJob[], io: InFlightIO = defaultIO): void {
	const path = inFlightPath(io);
	try {
		if (jobs.length === 0) {
			if (existsSync(path)) unlinkSync(path);
			return;
		}
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		const staging = `${path}.new`;
		writeFileSync(staging, `${JSON.stringify(jobs, null, 2)}\n`, { mode: 0o600 });
		renameSync(staging, path);
	} catch {
		/* bookkeeping, and never worth failing a run over */
	}
}

/**
 * Reads what the last process was doing, and forgets it.
 *
 * Anything unreadable comes back empty. A file that is corrupt, truncated or
 * written by a future version says nothing trustworthy about which runs were in
 * flight, and inventing job ids from it would end runs that are alive.
 */
export function takeInFlight(io: InFlightIO = defaultIO): InFlightJob[] {
	const path = inFlightPath(io);
	let raw: string;
	try {
		if (!existsSync(path)) return [];
		raw = readFileSync(path, "utf8");
	} catch {
		return [];
	}

	try {
		unlinkSync(path);
	} catch {
		/* read already succeeded; a file that cannot be removed is reported once more
		   at the next start, and the room refuses the second ending */
	}

	return parseInFlight(raw);
}

/** Split out so the shape rules are tested without touching a disk. */
export function parseInFlight(raw: string): InFlightJob[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];

	const seen = new Set<string>();
	const jobs: InFlightJob[] = [];
	for (const entry of parsed) {
		if (!entry || typeof entry !== "object") continue;
		const { job_id: jobId, started_at: startedAt } = entry as Record<string, unknown>;
		if (typeof jobId !== "string" || !jobId.trim()) continue;
		if (seen.has(jobId)) continue;
		seen.add(jobId);
		jobs.push({
			job_id: jobId,
			started_at: typeof startedAt === "string" ? startedAt : "",
		});
	}
	return jobs.slice(0, MAX_CARRIED);
}

/**
 * The endings owed to runs that did not survive the restart.
 *
 * `failed` and not `orphaned`, which is a distinction worth keeping. Orphaned is
 * the machine being gone, and a person reading it goes to check whether the
 * computer is on. This machine is on, answering, and running the daemon that is
 * telling them: what failed is the run.
 *
 * The author is the runtime, naming the mechanism. The persona did not stop and
 * did not fail; its process was replaced underneath it. An ending attributed to
 * the persona would be the record putting a decision in the mouth of a worker
 * that was not consulted.
 */
export function endingsFor(jobs: readonly InFlightJob[], now: Date = new Date()): WireEvent[] {
	const author: WireAuthor = {
		kind: "runtime",
		mechanism: RESTART_MECHANISM,
		reason: "the daemon was restarted while this run was in flight",
	};

	return jobs.map((job) => ({
		job_id: job.job_id,
		// Zero, which the protocol defines as "not yet assigned": the room stamps
		// the real one, because order is decided in one place or not at all.
		seq: 0,
		ts: now.toISOString(),
		source: "daemon",
		author,
		kind: "persona.session.ended",
		status: "failed",
		reason:
			"The daemon on this machine restarted while this run was working, so the run stopped there. " +
			"It ends where its record does, and an agent cannot be picked back up once its process is gone.",
	}));
}
