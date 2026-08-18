// Turning a job.assign into a running agent.
//
// The message existed and nothing matched on it, so the daemon could be given work and
// would silently do nothing. These tests are mostly about the refusals, because a refusal
// that is not reported looks exactly like that same silence.

import type { ServerToDaemonMsg, WireEvent } from "@personaxis/protocol/workspace";
import { hashPolicy } from "@personaxis/core";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { HostSession } from "../src/workspace/host-session.js";
import { JobRunner } from "../src/workspace/job-runner.js";

/**
 * A policy ref the daemon will accept.
 *
 * Built through  rather than with a made-up hash, because the runner
 * recomputes it and refuses a mismatch. A fixture with a fake hash would make every
 * test below assert the refusal path instead of the one it names.
 */
function policyRef(personaVersionId = "pv_1") {
	const rules = {
		persona_version_id: personaVersionId,
		compiled_at: "2026-08-15T00:00:00.000Z",
		ttl_seconds: 900,
		deny: [],
		allow: [],
		hard_limits: [],
		prohibited_behaviors: [],
		egress_allowlist: [],
		sandbox: "workspace-write",
		approval: "on-request",
		gate_rules: [],
	};
	return { persona_version_id: personaVersionId, hash: hashPolicy(rules as never), rules };
}

function assign(overrides: Partial<Extract<ServerToDaemonMsg, { type: "job.assign" }>> = {}) {
	return {
		type: "job.assign" as const,
		job_id: "job_1",
		persona_version_id: "pv_1",
		policy: policyRef(),
		trigger_context: { prompt: "write the brief" },
		...overrides,
	};
}

function runner(options: {
	scope?: string[];
	launcher?: () => { command: string; args: string[] } | null;
	maxConcurrent?: number;
	sessionRuns?: () => Promise<"completed" | "failed" | "stopped">;
	onPolicy?: () => void;
	/** Called when a session is constructed, to observe the order of things. */
	onStart?: () => void;
} = {}) {
	const events: WireEvent[] = [];
	const started: Array<{ cwd: string; prompt: string; command: string }> = [];
	const stopped = vi.fn();

	const instance = new JobRunner({
		sink: { emit: (event) => events.push(event), finishJob: () => {} },
		scope: options.scope ?? ["/work/repo"],
		host: "claude-code",
		launcher: options.launcher ?? (() => ({ command: "claude", args: ["-p"] })),
		...(options.maxConcurrent ? { maxConcurrent: options.maxConcurrent } : {}),
		...(options.onPolicy ? { onPolicy: options.onPolicy } : {}),
		createSession: (opts) => {
			options.onStart?.();
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

describe("the project's directory, proposed and verified", () => {
	// A project is a boundary for memory and for history, and it stopped being one at
	// the exact moment the work happened: every project ran in `scope[0]`, so two
	// clients' work landed in the same folder and edited each other's files. The
	// workspace may now say which folder. It still may not choose one.

	it("runs where the workspace asked, when that is inside the consented scope", () => {
		const { instance, started } = runner({ scope: ["/work/acme", "/work/globex"] });
		instance.handle(assign({ working_dir: "/work/globex" }));

		expect(started[0].cwd).toBe("/work/globex");
	});

	it("refuses a directory outside the scope instead of quietly using another", () => {
		// Clamping would be worse than refusing. The job would run, in the wrong
		// project's folder, and look like it worked.
		const { instance, started, events } = runner({ scope: ["/work/acme"] });
		instance.handle(assign({ working_dir: "/etc" }));

		expect(started).toHaveLength(0);
		expect(JSON.stringify(events)).toContain("did not consent");
	});

	it("is not fooled by a directory that merely starts with a consented one", () => {
		// The classic way a scope check turns out never to have been one.
		const { instance, started } = runner({ scope: ["/work/acme"] });
		instance.handle(assign({ working_dir: "/work/acme-other" }));

		expect(started).toHaveLength(0);
	});

	it("falls back to the first consented directory when nothing is proposed", () => {
		// What every daemon written before this field did, and what an older
		// workspace still sends.
		const { instance, started } = runner({ scope: ["/work/acme"] });
		instance.handle(assign());

		expect(started[0].cwd).toBe("/work/acme");
	});
});

describe("who is doing the work", () => {
	// Without this the daemon starts a host agent with an instruction and nothing
	// else: a generic agent doing a task, with the persona a row in a database that
	// no process ever saw.

	it("puts the persona in front of the instruction", () => {
		const { instance, started } = runner();
		instance.handle(
			assign({
				persona_document: "# You are Clio\n\nYou are terse and you never write marketing copy.",
				trigger_context: { prompt: "summarise the inbox" },
			}),
		);

		expect(started[0].prompt).toContain("You are Clio");
		expect(started[0].prompt).toContain("summarise the inbox");
		expect(started[0].prompt.indexOf("You are Clio")).toBeLessThan(
			started[0].prompt.indexOf("summarise the inbox"),
		);
	});

	it("marks which half is the instruction", () => {
		// Two blocks of prose with no marking are read as one, which is nearly right
		// and fails on the persona document that contains an imperative sentence.
		const { instance, started } = runner();
		instance.handle(
			assign({
				persona_document: "You always ship the changelog entry.",
				trigger_context: { prompt: "write the release notes" },
			}),
		);

		expect(started[0].prompt).toContain("What you have been asked to do in this run:");
	});

	it("runs the instruction alone when no persona travelled", () => {
		// An older workspace sends no document. Refusing would take the machine
		// offline for every job until both sides ship.
		const { instance, started } = runner();
		instance.handle(assign({ trigger_context: { prompt: "just this" } }));

		expect(started[0].prompt).toBe("just this");
	});

	it("hands the policy over before the agent starts, never after", () => {
		// The hook decides every call against the cache. A session that began before
		// its policy landed would enforce whatever was cached from something else.
		const order: string[] = [];
		const { instance } = runner({
			onPolicy: () => order.push("policy"),
			onStart: () => order.push("start"),
		});
		instance.handle(assign());

		expect(order).toEqual(["policy", "start"]);
	});
});

describe("a policy that is not what it claims to be", () => {
	// The hook decides every call against this. Enforcing a policy nobody wrote is
	// worse than enforcing none, because it looks exactly like enforcement and
	// reports every decision with complete confidence.

	it("refuses a job whose policy does not match its own hash", () => {
		const ref = policyRef();
		const { instance, started, events } = runner();
		instance.handle(assign({ policy: { ...ref, hash: "0".repeat(64) } }));

		expect(started).toHaveLength(0);
		expect(JSON.stringify(events)).toContain("does not match its own hash");
	});

	it("refuses a policy that is missing rules the hook enforces", () => {
		// Filling a missing deny list with an empty one turns "this policy is broken"
		// into "this persona may do anything".
		const ref = policyRef();
		const { rules, ...rest } = ref;
		const { deny: _dropped, ...withoutDeny } = rules as Record<string, unknown>;
		const { instance, started, events } = runner();
		instance.handle(assign({ policy: { ...rest, rules: withoutDeny } as never }));

		expect(started).toHaveLength(0);
		expect(JSON.stringify(events)).toContain("missing rules");
	});

	it("refuses a policy that names a different persona than the envelope", () => {
		// Two answers to "whose policy is this" is one too many, and the wrong one
		// caches a policy under a version it does not govern.
		const ref = policyRef("pv_other");
		const { instance, started, events } = runner();
		instance.handle(assign({ policy: { ...ref, persona_version_id: "pv_1" } }));

		expect(started).toHaveLength(0);
		expect(JSON.stringify(events)).toContain("different persona");
	});
});

describe("naming what the step left behind", () => {
	/**
	 * A session that writes a file and then ends, the way a real agent does.
	 *
	 * The default harness above never emits an ending, because `HostSession` is what
	 * emits one and it is faked there. This one does, and the ordering it produces is
	 * the whole point of these tests.
	 */
	function runnerWritingInto(dir: string, writes: () => Promise<void>) {
		const events: WireEvent[] = [];
		const finished: string[] = [];

		const instance = new JobRunner({
			sink: { emit: (event) => events.push(event), finishJob: (id) => finished.push(id) },
			scope: [dir],
			host: "claude-code",
			launcher: () => ({ command: "claude", args: ["-p"] }),
			createSession: (opts) =>
				({
					run: async () => {
						await writes();
						opts.emit({ kind: "persona.session.ended", status: "completed", reason: null });
						return "completed" as const;
					},
					stop: () => {},
					turns: 0,
				}) as unknown as HostSession,
		});

		return { instance, events, finished };
	}

	it("names a file the step wrote, with a relative path and its size", async () => {
		const dir = await mkdtemp(join(tmpdir(), "runner-"));
		try {
			const { instance, events } = runnerWritingInto(dir, async () => {
				await writeFile(join(dir, "brief.md"), "twelve chars");
			});

			instance.handle(assign({ working_dir: dir }));
			await vi.waitFor(() => expect(endings(events)).toHaveLength(1));

			const artifacts = events.filter((event) => event.kind === "artifact.created");
			expect(artifacts).toHaveLength(1);
			expect(artifacts[0]).toMatchObject({
				kind: "artifact.created",
				artifact_kind: "markdown",
				path: "brief.md",
				bytes: 12,
			});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("names them BEFORE the ending, because the ending closes the job", async () => {
		// The bug this was written after. `persona.session.ended` is the reporter's
		// terminal event: it releases the connection's queue for this job and the
		// workspace moves the row to its final status on it. An artifact emitted after
		// it is a late event arriving at a job that is already over, which the record
		// writer correctly ignores, so naming the files afterwards was naming them
		// into nothing.
		const dir = await mkdtemp(join(tmpdir(), "runner-"));
		try {
			const { instance, events, finished } = runnerWritingInto(dir, async () => {
				await writeFile(join(dir, "out.json"), "{}");
			});

			instance.handle(assign({ working_dir: dir }));
			await vi.waitFor(() => expect(endings(events)).toHaveLength(1));

			const order = events.map((event) => event.kind);
			expect(order.indexOf("artifact.created")).toBeGreaterThan(-1);
			expect(order.indexOf("artifact.created")).toBeLessThan(
				order.indexOf("persona.session.ended"),
			);
			// And the job is only released once, after all of it.
			expect(finished).toEqual(["job_1"]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("ends the job even when there is nothing to name", async () => {
		// A step that wrote nothing is a normal outcome, and it must not look like a
		// run that never finished.
		const dir = await mkdtemp(join(tmpdir(), "runner-"));
		try {
			const { instance, events } = runnerWritingInto(dir, async () => {});

			instance.handle(assign({ working_dir: dir }));
			await vi.waitFor(() => expect(endings(events)).toHaveLength(1));

			expect(events.filter((event) => event.kind === "artifact.created")).toEqual([]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
