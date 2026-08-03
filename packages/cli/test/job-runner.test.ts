// Turning a job.assign into a running agent.
//
// The message existed and nothing matched on it, so the daemon could be given work and
// would silently do nothing. These tests are mostly about the refusals, because a refusal
// that is not reported looks exactly like that same silence.

import type { ServerToDaemonMsg, WireEvent } from "@personaxis/protocol/workspace";
import { describe, expect, it, vi } from "vitest";

import type { HostSession } from "../src/workspace/host-session.js";
import { JobRunner } from "../src/workspace/job-runner.js";

function assign(overrides: Partial<Extract<ServerToDaemonMsg, { type: "job.assign" }>> = {}) {
	return {
		type: "job.assign" as const,
		job_id: "job_1",
		persona_version_id: "pv_1",
		policy: { persona_version_id: "pv_1", hash: "h", body: {} } as never,
		trigger_context: { prompt: "write the brief" },
		...overrides,
	};
}

function runner(options: {
	scope?: string[];
	launcher?: () => { command: string; args: string[] } | null;
	maxConcurrent?: number;
	sessionRuns?: () => Promise<"completed" | "failed" | "stopped">;
}) {
	const events: WireEvent[] = [];
	const started: Array<{ cwd: string; prompt: string; command: string }> = [];
	const stopped = vi.fn();

	const instance = new JobRunner({
		sink: { emit: (event) => events.push(event), finishJob: () => {} },
		scope: options.scope ?? ["/work/repo"],
		host: "claude-code",
		launcher: options.launcher ?? (() => ({ command: "claude", args: ["-p"] })),
		...(options.maxConcurrent ? { maxConcurrent: options.maxConcurrent } : {}),
		createSession: (opts) => {
			started.push({ cwd: opts.cwd, prompt: opts.prompt, command: opts.command });
			return {
				run: options.sessionRuns ?? (() => Promise.resolve("completed")),
				stop: stopped,
				turns: 0,
			} as unknown as HostSession;
		},
	});

	return { instance, events, started, stopped };
}

const endings = (events: WireEvent[]) => events.filter((e) => e.kind === "persona.session.ended");

/** Let the run's promise and its `finally` reach the microtask queue. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("running an assigned job", () => {
	it("starts the agent with the prompt from the job", () => {
		const { instance, started } = runner({});
		instance.handle(assign());

		expect(started).toHaveLength(1);
		expect(started[0]).toMatchObject({ prompt: "write the brief", command: "claude" });
	});

	it("tells the room the session started before anything else can go wrong", () => {
		// A refusal then arrives as a session that began and ended, rather than as nothing.
		const { instance, events } = runner({ launcher: () => null });
		instance.handle(assign());

		expect(events[0]).toMatchObject({ kind: "persona.session.started" });
		expect(endings(events)).toHaveLength(1);
	});

	it("stops a running job when the workspace says stop", () => {
		const { instance, stopped } = runner({ sessionRuns: () => new Promise(() => {}) });
		instance.handle(assign());
		instance.handle({ type: "job.stop", job_id: "job_1" });

		expect(stopped).toHaveBeenCalled();
	});

	it("ignores a stop for a job it is not running", () => {
		// The workspace may send it while the run was already ending. Answering would be
		// inventing an event.
		const { instance, events } = runner({});
		instance.handle({ type: "job.stop", job_id: "unknown" });

		expect(events).toEqual([]);
	});
});

describe("the consented scope is not negotiable", () => {
	it("runs in the directory the operator consented to, never one from the message", () => {
		// The attack this refuses: a workspace, or anything that has compromised one, sends a
		// working directory of its choosing and the daemon starts an agent there. The scope
		// is decided at the operator's keyboard and nothing on the wire can widen it.
		const { instance, started } = runner({ scope: ["/work/repo"] });
		instance.handle(
			assign({
				trigger_context: {
					prompt: "write the brief",
					cwd: "/etc",
					working_dir: "/",
					path: "C:\\Users",
				},
			}),
		);

		expect(started[0].cwd).toBe("/work/repo");
	});

	it("refuses when the operator consented to nothing", () => {
		// Empty means empty. Falling back to a home directory would turn "I exposed nothing"
		// into "I exposed everything".
		const { instance, events, started } = runner({ scope: [] });
		instance.handle(assign());

		expect(started).toHaveLength(0);
		expect(endings(events)[0]).toMatchObject({ reason: expect.stringContaining("no directories") });
	});
});

describe("refusing out loud", () => {
	it("says when no host agent is installed", () => {
		const { instance, events } = runner({ launcher: () => null });
		instance.handle(assign());

		expect(endings(events)[0]).toMatchObject({
			status: "failed",
			reason: expect.stringContaining("claude-code"),
		});
	});

	it("says when the job carried no prompt", () => {
		// An agent started with an empty prompt does something arbitrary, in a real directory,
		// with real tools.
		const { instance, events, started } = runner({});
		instance.handle(assign({ trigger_context: {} }));

		expect(started).toHaveLength(0);
		expect(endings(events)[0]).toMatchObject({ reason: expect.stringContaining("no prompt") });
	});

	it("refuses a prompt that is only whitespace", () => {
		const { instance, started } = runner({});
		instance.handle(assign({ trigger_context: { prompt: "   " } }));

		expect(started).toHaveLength(0);
	});

	it("refuses a second agent for a job already running", () => {
		// A duplicate assign, which a reconnect can produce. A second agent would double
		// every event in the record and leave two processes editing the same files.
		const { instance, events, started } = runner({ sessionRuns: () => new Promise(() => {}) });
		instance.handle(assign());
		instance.handle(assign());

		expect(started).toHaveLength(1);
		expect(endings(events)[0]).toMatchObject({ reason: expect.stringContaining("already running") });
	});

	it("refuses more concurrent jobs than the machine allows", () => {
		const { instance, events, started } = runner({ sessionRuns: () => new Promise(() => {}) });
		instance.handle(assign({ job_id: "job_1" }));
		instance.handle(assign({ job_id: "job_2" }));

		expect(started).toHaveLength(1);
		expect(endings(events)[0]).toMatchObject({ reason: expect.stringContaining("all it allows") });
	});

	it("frees the slot when a run finishes", async () => {
		// Otherwise the first job a machine ever runs is the last one it can run.
		const { instance, started } = runner({});

		instance.handle(assign({ job_id: "job_1" }));
		await settle();
		expect(instance.activeCount).toBe(0);

		instance.handle(assign({ job_id: "job_2" }));
		await settle();

		expect(started).toHaveLength(2);
		expect(instance.activeCount).toBe(0);
	});
});
